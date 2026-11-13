import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_TOOL_QUEUE_SETTINGS, toolQueueSettingsSchema, type ToolQueueSettings } from './diagnosticContract.js';
import type { Observability } from './observability.js';

export const TOOL_QUEUE_LIMITS = {
  running: DEFAULT_TOOL_QUEUE_SETTINGS.maxConcurrency,
  waiting: DEFAULT_TOOL_QUEUE_SETTINGS.maxQueueSize,
  waitMs: DEFAULT_TOOL_QUEUE_SETTINGS.queueTimeoutMs,
};
export type ToolExecutionOutcome = 'completed' | 'failed' | 'not_executed';
export interface QueuedTool {
  requestId: string;
  operation: string;
  caller: string;
  queuedAt: number;
  startedAt?: number;
}
type QueueCode = 'full' | 'expired' | 'cancelled' | 'shutdown';
export class ToolQueueError extends Error {
  constructor(readonly code: QueueCode) {
    super(`Tool call not executed: queue ${code}. ${code === 'full' || code === 'expired' ? 'Try again when the instance has capacity.' : ''}`.trim());
  }
}
interface Pending extends QueuedTool {
  timeoutMs: number;
  payload: unknown;
  start: () => void;
  reject: (error: ToolQueueError) => void;
  cleanup: () => void;
}
export class QueueSettingsConflictError extends Error {
  constructor() { super('Queue settings changed. Refresh Queue before saving again.'); }
}

export class ToolQueue {
  private settings: ToolQueueSettings;
  private readonly waiting: Pending[] = [];
  private readonly running = new Map<string, QueuedTool>();
  private ticker: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private peakDepth = 0;
  private peakWaitMs = 0;
  private readonly requestsByTool = new Map<string, number>();
  private readonly drops = { timeouts: 0, rejections: 0, shutdown: 0 };
  private readonly timingsByTool = new Map<string, { finished: number; executed: number; waitMs: number; runMs: number }>();

  constructor(private readonly db: DatabaseSync, private readonly memoryBlocked: (thresholdPercent: number) => boolean,
    private readonly clock = Date.now, private readonly observability?: Observability) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_tool_queue_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1), settings TEXT NOT NULL
    ) STRICT`);
    const saved = db.prepare('SELECT settings FROM instance_tool_queue_settings WHERE singleton=1').get();
    this.settings = saved ? toolQueueSettingsSchema.parse(JSON.parse(String(saved.settings))) : { ...DEFAULT_TOOL_QUEUE_SETTINGS };
  }

  configure(settings: ToolQueueSettings, expectedSettings: ToolQueueSettings): void {
    const next = toolQueueSettingsSchema.parse(settings);
    if (JSON.stringify(toolQueueSettingsSchema.parse(expectedSettings)) !== JSON.stringify(this.settings)) {
      throw new QueueSettingsConflictError();
    }
    this.db.prepare(`INSERT INTO instance_tool_queue_settings VALUES(1,?)
      ON CONFLICT(singleton) DO UPDATE SET settings=excluded.settings`).run(JSON.stringify(next));
    this.settings = next;
    this.pump();
  }

  private record(item: QueuedTool, event: string): void {
    if (!this.observability?.enabled) return;
    if (event === 'expired') this.drops.timeouts++;
    else if (event === 'full') this.drops.rejections++;
    else if (event === 'shutdown') this.drops.shutdown++;
    const now = this.clock();
    const startedAt = event === 'not_executed' ? undefined : item.startedAt;
    const waitMs = Math.max(0, (item.startedAt ?? now) - item.queuedAt);
    if (item.startedAt === undefined || event === 'started') this.peakWaitMs = Math.max(this.peakWaitMs, waitMs);
    const runMs = startedAt === undefined ? 0 : Math.max(0, now - startedAt);
    if (event === 'completed' || event === 'failed' || event === 'not_executed'
      || event === 'full' || event === 'expired' || event === 'cancelled' || event === 'shutdown') {
      const totals = this.timingsByTool.get(item.operation) ?? { finished: 0, executed: 0, waitMs: 0, runMs: 0 };
      totals.finished++;
      totals.waitMs += waitMs;
      if (event === 'completed' || event === 'failed') { totals.executed++; totals.runMs += runMs; }
      this.timingsByTool.set(item.operation, totals);
    }
    this.observability.recordQueue({
      at: now, requestId: item.requestId, operation: item.operation, caller: item.caller, event,
      waiting: this.waiting.length, running: this.running.size, waitMs, runMs,
    });
  }

  private remove(item: Pending, code: QueueCode): void {
    const index = this.waiting.indexOf(item);
    if (index < 0) return;
    this.waiting.splice(index, 1);
    item.cleanup();
    this.record(item, code);
    item.reject(new ToolQueueError(code));
    this.pump();
  }

  private dispatch(item: Pending, startedAt: number): void {
    item.startedAt = startedAt;
    this.running.set(item.requestId, {
      requestId: item.requestId, operation: item.operation, caller: item.caller,
      queuedAt: item.queuedAt, startedAt,
    });
    this.record(item, 'started');
    item.start();
  }

  private pump(): void {
    if (this.stopped) return;
    while (this.waiting.length && this.running.size < this.settings.maxConcurrency) {
      const item = this.waiting[0];
      if (this.clock() - item.queuedAt >= item.timeoutMs) {
        this.remove(item, 'expired');
        continue;
      }
      if (this.memoryBlocked(this.settings.heapDispatchPausePercent)) break;
      this.waiting.shift();
      item.cleanup();
      this.dispatch(item, this.clock());
    }
    if (!this.waiting.length && this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
  }

  run<T>(metadata: Omit<QueuedTool, 'queuedAt' | 'startedAt'>, payload: unknown, signal: AbortSignal,
    action: () => Promise<T>, outcome: (value: T) => ToolExecutionOutcome = () => 'completed'): Promise<T> {
    if (this.observability?.enabled) {
      this.requestsByTool.set(metadata.operation, (this.requestsByTool.get(metadata.operation) ?? 0) + 1);
    }
    const queuedAt = this.clock();
    const startImmediately = !this.stopped && !signal.aborted && !this.waiting.length
      && this.running.size < this.settings.maxConcurrency
      && !this.memoryBlocked(this.settings.heapDispatchPausePercent);
    if (this.stopped || signal.aborted || (!startImmediately && this.waiting.length >= this.settings.maxQueueSize)) {
      const code = this.stopped ? 'shutdown' : signal.aborted ? 'cancelled' : 'full';
      this.record({ ...metadata, queuedAt }, code);
      return Promise.reject(new ToolQueueError(code));
    }
    const timeoutMs = this.settings.queueTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => this.remove(item, 'cancelled');
      const timer = startImmediately ? undefined : setTimeout(() => this.remove(item, 'expired'), timeoutMs);
      timer?.unref();
      const item: Pending = { ...metadata, queuedAt, payload, reject, timeoutMs,
        cleanup: () => { if (timer) clearTimeout(timer); signal.removeEventListener('abort', cancel); },
        start: () => {
          const finish = (event: string) => {
            this.running.delete(item.requestId);
            this.record(item, event);
            this.pump();
          };
          void Promise.resolve().then(action).then(value => {
            finish(outcome(value));
            resolve(value);
          }).catch(error => { finish('failed'); reject(error); });
        },
      };
      if (startImmediately) {
        this.dispatch(item, queuedAt);
        return;
      }
      this.waiting.push(item);
      if (this.observability?.enabled) this.peakDepth = Math.max(this.peakDepth, this.waiting.length);
      this.record(item, 'queued');
      signal.addEventListener('abort', cancel, { once: true });
      this.ticker ??= setInterval(() => this.pump(), 100);
      this.ticker.unref();
      this.pump();
    });
  }

  inspect(requestId: string): unknown {
    return this.waiting.find(item => item.requestId === requestId)?.payload;
  }

  resetSamplingPeaks(): void {
    this.peakDepth = this.waiting.length;
    this.peakWaitMs = 0;
  }

  processing() {
    return this.observability?.enabled ? this.observability.processing() : undefined;
  }

  state() {
    const now = this.clock();
    return {
      observedAt: now, settings: { ...this.settings },
      maxQueueWaitMs: Math.max(this.observability?.enabled ? this.peakWaitMs : 0,
        ...this.waiting.map(item => Math.max(0, now - item.queuedAt))),
      limits: { running: this.settings.maxConcurrency, waiting: this.settings.maxQueueSize, waitMs: this.settings.queueTimeoutMs },
      memoryBlocked: this.memoryBlocked(this.settings.heapDispatchPausePercent),
      ...(this.observability?.enabled ? {
        peakQueueDepth: Math.max(this.peakDepth, this.waiting.length),
        processing: this.processing(),
        requestsByTool: Object.fromEntries(this.requestsByTool),
        queueDrops: { ...this.drops },
        timingsByTool: Object.fromEntries([...this.timingsByTool].map(([tool, totals]) => [tool, { ...totals }])),
      } : {}),
      running: this.running.size, waiting: this.waiting.length,
      items: [...this.running.values(), ...this.waiting.map(({ requestId, operation, caller, queuedAt }) => ({
        requestId, operation, caller, queuedAt,
      }))],
    };
  }

  events(limit = 100) {
    return this.observability?.enabled ? this.observability.queueEvents(limit) : [];
  }

  close(): void {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    for (const item of [...this.waiting]) this.remove(item, 'shutdown');
  }
}
