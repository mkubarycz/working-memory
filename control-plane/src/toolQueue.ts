import type { DatabaseSync } from 'node:sqlite';

export const TOOL_QUEUE_LIMITS = { running: 4, waiting: 16, waitMs: 5000 } as const;
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
  payload: unknown;
  start: () => void;
  reject: (error: ToolQueueError) => void;
  cleanup: () => void;
}

export class ToolQueue {
  private readonly waiting: Pending[] = [];
  private readonly running = new Map<string, QueuedTool>();
  private ticker: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  private peakDepth = 0;
  private readonly requestsByTool = new Map<string, number>();
  private lastProcessingPruneSecond: number | undefined;

  constructor(private readonly db: DatabaseSync, private readonly memoryBlocked: () => boolean,
    private readonly clock = Date.now) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_tool_queue_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, request_id TEXT NOT NULL,
      operation TEXT NOT NULL, caller TEXT NOT NULL, event TEXT NOT NULL,
      waiting INTEGER NOT NULL, running INTEGER NOT NULL, wait_ms REAL NOT NULL, run_ms REAL NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS instance_tool_queue_seconds (
      at INTEGER PRIMARY KEY, count INTEGER NOT NULL, wait_ms REAL NOT NULL, run_ms REAL NOT NULL
    ) STRICT`);
    this.prune();
    this.pruneProcessing(this.clock());
  }

  private prune(): void {
    this.db.prepare('DELETE FROM instance_tool_queue_events WHERE at<?').run(this.clock() - 86400000);
    this.db.prepare(`DELETE FROM instance_tool_queue_events WHERE sequence IN
      (SELECT sequence FROM instance_tool_queue_events ORDER BY sequence DESC LIMIT -1 OFFSET 2000)`).run();
  }

  private record(item: QueuedTool, event: string): void {
    try {
      const now = this.clock();
      const startedAt = event === 'not_executed' ? undefined : item.startedAt;
      const waitMs = Math.max(0, (startedAt ?? now) - item.queuedAt);
      const runMs = startedAt === undefined ? 0 : Math.max(0, now - startedAt);
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
    while (this.waiting.length && this.running.size < TOOL_QUEUE_LIMITS.running) {
      const item = this.waiting[0];
      if (this.clock() - item.queuedAt >= TOOL_QUEUE_LIMITS.waitMs) {
        this.remove(item, 'expired');
        continue;
      }
      if (this.memoryBlocked()) break;
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
    if (this.stopped || signal.aborted || this.waiting.length >= TOOL_QUEUE_LIMITS.waiting) {
      const code = this.stopped ? 'shutdown' : signal.aborted ? 'cancelled' : 'full';
      this.record({ ...metadata, queuedAt }, code);
      return Promise.reject(new ToolQueueError(code));
    }
    return new Promise<T>((resolve, reject) => {
      const cancel = () => this.remove(item, 'cancelled');
      const timer = setTimeout(() => this.remove(item, 'expired'), TOOL_QUEUE_LIMITS.waitMs);
      timer.unref();
      const item: Pending = { ...metadata, queuedAt, payload, reject,
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
      observedAt: this.clock(), limits: TOOL_QUEUE_LIMITS, memoryBlocked: this.memoryBlocked(),
      processing: this.processing(),
      requestsByTool: Object.fromEntries(this.requestsByTool),
      running: this.running.size, waiting: this.waiting.length,
      items: [...this.running.values(), ...this.waiting.map(({ requestId, operation, caller, queuedAt }) => ({
        requestId, operation, caller, queuedAt,
      }))],
    };
  }

  events() {
    this.prune();
    return this.db.prepare('SELECT * FROM instance_tool_queue_events ORDER BY sequence DESC LIMIT 100').all().map(row => ({
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
