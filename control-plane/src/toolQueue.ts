import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_TOOL_QUEUE_SETTINGS, toolQueueSettingsSchema, type ToolQueueSettings } from './diagnosticContract.js';

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
  private readonly requestsByTool = new Map<string, number>();
  private readonly timingsByTool = new Map<string, { finished: number; executed: number; waitMs: number; runMs: number }>();
  private lastProcessingPruneSecond: number | undefined;

  constructor(private readonly db: DatabaseSync, private readonly memoryBlocked: (thresholdPercent: number) => boolean,
    private readonly clock = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_tool_queue_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, request_id TEXT NOT NULL,
      operation TEXT NOT NULL, caller TEXT NOT NULL, event TEXT NOT NULL,
      waiting INTEGER NOT NULL, running INTEGER NOT NULL, wait_ms REAL NOT NULL, run_ms REAL NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS instance_tool_queue_seconds (
      at INTEGER PRIMARY KEY, count INTEGER NOT NULL, wait_ms REAL NOT NULL, run_ms REAL NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS instance_tool_queue_settings (
      singleton INTEGER PRIMARY KEY CHECK (singleton=1), settings TEXT NOT NULL
    ) STRICT`);
    const saved = db.prepare('SELECT settings FROM instance_tool_queue_settings WHERE singleton=1').get();
    this.settings = saved ? toolQueueSettingsSchema.parse(JSON.parse(String(saved.settings))) : { ...DEFAULT_TOOL_QUEUE_SETTINGS };
    this.prune();
    this.pruneProcessing(this.clock());
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

  private prune(): void {
    this.db.prepare('DELETE FROM instance_tool_queue_events WHERE at<?').run(this.clock() - 86400000);
    this.db.prepare(`DELETE FROM instance_tool_queue_events WHERE sequence IN
      (SELECT sequence FROM instance_tool_queue_events ORDER BY sequence DESC LIMIT -1 OFFSET 2000)`).run();
  }

  private record(item: QueuedTool, event: string): void {
    const now = this.clock();
    const startedAt = event === 'not_executed' ? undefined : item.startedAt;
    const waitMs = Math.max(0, (startedAt ?? now) - item.queuedAt);
    const runMs = startedAt === undefined ? 0 : Math.max(0, now - startedAt);
    if (event === 'completed' || event === 'failed' || event === 'not_executed'
      || event === 'full' || event === 'expired' || event === 'cancelled' || event === 'shutdown') {
      const totals = this.timingsByTool.get(item.operation) ?? { finished: 0, executed: 0, waitMs: 0, runMs: 0 };
      totals.finished++;
      totals.waitMs += waitMs;
      if (event === 'completed' || event === 'failed') { totals.executed++; totals.runMs += runMs; }
      this.timingsByTool.set(item.operation, totals);
    }
    try {
      this.db.prepare(`INSERT INTO instance_tool_queue_events
        (at,request_id,operation,caller,event,waiting,running,wait_ms,run_ms) VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(now, item.requestId, item.operation, item.caller, event, this.waiting.length, this.running.size,
          waitMs, runMs);
      if (event === 'completed' || event === 'failed') {
        const second = Math.floor(now / 1000) * 1000;
        this.db.prepare(`INSERT INTO instance_tool_queue_seconds VALUES(?,1,?,?)
          ON CONFLICT(at) DO UPDATE SET count=count+1,wait_ms=wait_ms+excluded.wait_ms,run_ms=run_ms+excluded.run_ms`)
          .run(second, waitMs, runMs);
        if (second !== this.lastProcessingPruneSecond) this.pruneProcessing(now);
      }
      this.prune();
    } catch (error) { console.error('[tool-queue] Unable to record queue lifecycle:', error); }
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
      item.startedAt = this.clock();
      this.running.set(item.requestId, {
        requestId: item.requestId, operation: item.operation, caller: item.caller,
        queuedAt: item.queuedAt, startedAt: item.startedAt,
      });
      this.record(item, 'started');
      item.start();
    }
    if (!this.waiting.length && this.ticker) { clearInterval(this.ticker); this.ticker = undefined; }
    this.peakDepth = Math.max(this.peakDepth, this.waiting.length);
  }

  run<T>(metadata: Omit<QueuedTool, 'queuedAt' | 'startedAt'>, payload: unknown, signal: AbortSignal,
    action: () => Promise<T>, outcome: (value: T) => ToolExecutionOutcome = () => 'completed'): Promise<T> {
    this.requestsByTool.set(metadata.operation, (this.requestsByTool.get(metadata.operation) ?? 0) + 1);
    const queuedAt = this.clock();
    if (this.stopped || signal.aborted || this.waiting.length >= this.settings.maxQueueSize) {
      const code = this.stopped ? 'shutdown' : signal.aborted ? 'cancelled' : 'full';
      this.record({ ...metadata, queuedAt }, code);
      return Promise.reject(new ToolQueueError(code));
    }
    const timeoutMs = this.settings.queueTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => this.remove(item, 'cancelled');
      const timer = setTimeout(() => this.remove(item, 'expired'), timeoutMs);
      timer.unref();
      const item: Pending = { ...metadata, queuedAt, payload, reject, timeoutMs,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); },
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
      this.waiting.push(item);
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

  takePeakDepth(): number {
    const peak = Math.max(this.peakDepth, this.waiting.length);
    this.peakDepth = this.waiting.length;
    return peak;
  }

  private pruneProcessing(now: number): void {
    const second = Math.floor(now / 1000) * 1000;
    this.db.prepare(`DELETE FROM instance_tool_queue_seconds WHERE at<? OR at IN
      (SELECT at FROM instance_tool_queue_seconds ORDER BY at DESC LIMIT -1 OFFSET 61)`).run(second - 60000);
    this.lastProcessingPruneSecond = second;
  }

  processing() {
    const second = Math.floor(this.clock() / 1000) * 1000;
    const row = this.db.prepare(`SELECT COALESCE(SUM(count),0) AS processed,
      COALESCE(SUM(CASE WHEN at>? THEN count ELSE 0 END),0)/10.0 AS rate,
      SUM(wait_ms)/NULLIF(SUM(count),0) AS wait_ms,SUM(run_ms)/NULLIF(SUM(count),0) AS run_ms
      FROM instance_tool_queue_seconds WHERE at>? AND at<=?`).get(second - 10000, second - 60000, second);
    if (!row) throw new Error('Queue processing aggregate is unavailable.');
    return {
      processedPerSecond: Number(row.rate), processedLastMinute: Number(row.processed),
      averageWaitMs: row.wait_ms === null ? null : Number(row.wait_ms),
      averageRunMs: row.run_ms === null ? null : Number(row.run_ms),
    };
  }

  state() {
    this.prune();
    this.pruneProcessing(this.clock());
    return {
      observedAt: this.clock(), settings: { ...this.settings },
      limits: { running: this.settings.maxConcurrency, waiting: this.settings.maxQueueSize, waitMs: this.settings.queueTimeoutMs },
      memoryBlocked: this.memoryBlocked(this.settings.heapDispatchPausePercent),
      processing: this.processing(),
      requestsByTool: Object.fromEntries(this.requestsByTool),
      timingsByTool: Object.fromEntries([...this.timingsByTool].map(([tool, totals]) => [tool, { ...totals }])),
      running: this.running.size, waiting: this.waiting.length,
      items: [...this.running.values(), ...this.waiting.map(({ requestId, operation, caller, queuedAt }) => ({
        requestId, operation, caller, queuedAt,
      }))],
    };
  }

  events(limit = 100) {
    this.prune();
    return this.db.prepare('SELECT * FROM instance_tool_queue_events ORDER BY sequence DESC LIMIT ?').all(limit).map(row => ({
      sequence: Number(row.sequence), at: Number(row.at), requestId: String(row.request_id),
      operation: String(row.operation), caller: String(row.caller), event: String(row.event),
      waiting: Number(row.waiting), running: Number(row.running), waitMs: Number(row.wait_ms), runMs: Number(row.run_ms),
    }));
  }

  close(): void {
    this.stopped = true;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    for (const item of [...this.waiting]) this.remove(item, 'shutdown');
  }
}
