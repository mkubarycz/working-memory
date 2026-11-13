import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import type { InstanceDiagnostics } from './diagnosticContract.js';
import { DOCUMENT_CHANGE_POLL_TIMEOUT_MS } from './documentChangeFeed.js';
import type { ToolQueue } from './toolQueue.js';
import type { Observability } from './observability.js';

const SLOW_REQUEST_MS = 3000;
const SLOW_CHANGE_POLL_MS = DOCUMENT_CHANGE_POLL_TIMEOUT_MS + SLOW_REQUEST_MS;

// Only known route shapes are retained, never user-controlled IDs, queries or headers.
export function diagnosticRoute(raw: string): string {
  const path = raw.split('?')[0];
  if (['/health', '/mcp', '/changes', '/attachments'].includes(path)) return path;
  if (/^\/attachments\/[^/]+$/.test(path)) return '/attachments/:id';
  if (path.startsWith('/identity/v1/')) return '/identity/v1/*';
  if (path.startsWith('/host-tasks/v1/')) return '/host-tasks/v1/*';
  if (/^\/features\/v[123]$/.test(path)) return path;
  if (path.startsWith('/oauth/') || path.startsWith('/.well-known/')) return '/oauth/*';
  return '/other';
}

export class HttpDiagnostics {
  readonly bootId: string;
  readonly startedAt: number;
  private activeRequests = 0;
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly gcObserver: PerformanceObserver;
  private gcActive = false;
  private gcCount = 0;
  private gcDurationMs = 0;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = performance.now();

  constructor(private readonly db: DatabaseSync, private readonly version: string, private readonly clock = Date.now,
    private readonly queue?: ToolQueue, private readonly observability?: Observability) {
    this.bootId = observability?.bootId ?? randomUUID();
    this.startedAt = clock();
    db.exec(`
      CREATE TABLE IF NOT EXISTS instance_diagnostic_run (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), boot_id TEXT NOT NULL, clean INTEGER NOT NULL
      ) STRICT;
    `);
    const previous = db.prepare('SELECT clean FROM instance_diagnostic_run WHERE singleton=1').get();
    if (previous && previous.clean === 0) this.event('unclean_restart');
    db.prepare(`INSERT INTO instance_diagnostic_run VALUES(1,?,0)
      ON CONFLICT(singleton) DO UPDATE SET boot_id=excluded.boot_id,clean=0`).run(this.bootId);
    this.lag.enable();
    this.gcObserver = new PerformanceObserver(list => {
      if (!this.observability?.enabled) return;
      for (const entry of list.getEntries()) { this.gcCount += 1; this.gcDurationMs += entry.duration; }
    });
    this.syncEnabled();
    this.timer = setInterval(() => {
      try {
        this.syncEnabled();
        if (!this.observability?.enabled) { this.lag.reset(); return; }
        const lag = this.lag.max / 1e6;
        if (lag >= 1000) this.event('event_loop_stall', null, '/runtime', 0, lag);
        if (process.memoryUsage().heapUsed >= getHeapStatistics().heap_size_limit * 0.6) {
          this.event('memory_pressure', null, '/runtime', 503, 0);
        }
        this.sample();
        this.lag.reset();
      } catch (error) { console.error('[diagnostics] Runtime sampling failed:', error); }
    }, 10000);
    this.timer.unref();
  }

  syncEnabled(): void {
    const enabled = this.observability?.enabled ?? false;
    if (enabled === this.gcActive) return;
    this.gcActive = enabled;
    this.gcCount = 0;
    this.gcDurationMs = 0;
    this.lag.reset();
    this.queue?.resetSamplingPeaks();
    if (enabled) {
      this.lastCpu = process.cpuUsage();
      this.lastCpuAt = performance.now();
      this.gcObserver.observe({ entryTypes: ['gc'] });
      this.sample();
    } else this.gcObserver.disconnect();
  }

  track(req: IncomingMessage, res: ServerResponse, caller: () => string): void {
    const requestId = randomUUID();
    const generation = this.observability?.collectionGeneration;
    const observation = generation === undefined ? undefined
      : { generation, start: this.clock(), route: diagnosticRoute(req.url ?? '/'), identity: caller() };
    const method = req.method;
    res.setHeader('X-Request-Id', requestId);
    this.activeRequests += 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.activeRequests -= 1;
      if (!observation || !this.observability || observation.generation !== this.observability.collectionGeneration) return;
      const { start, route, identity } = observation;
      const duration = Math.max(0, this.clock() - start), status = res.writableFinished ? res.statusCode : 499;
      try {
        const notificationStream = method === 'GET' && route === '/mcp' && status === 200
          && String(res.getHeader('content-type') ?? '').split(';', 1)[0].trim().toLowerCase() === 'text/event-stream';
        const slowThreshold = method === 'GET' && route === '/changes' ? SLOW_CHANGE_POLL_MS : SLOW_REQUEST_MS;
        this.observability.recordHttp({ caller: identity, method: method ?? 'OTHER', route, status,
          durationMs: duration, startedAt: start, streaming: notificationStream });
        if (status >= 400 || !notificationStream && duration >= slowThreshold) {
          this.event(status >= 400 ? 'http_error' : 'slow_request', requestId, route, status, duration);
        }
      } catch (error) { console.error('[diagnostics] Request recording failed:', error); }
    };
    res.once('finish', finish);
    res.once('close', finish);
  }

  event(code: string, requestId: string | null = null, route = '/runtime', status = 0, duration = 0): void {
    if (this.observability?.enabled) {
      this.observability.event(code, requestId, route, status, duration);
    }
  }

  sample(): void {
    if (!this.observability?.enabled) return;
    const memory = process.memoryUsage(), cpu = process.cpuUsage(), now = performance.now();
    const queue = this.queue?.state();
    const sample = {
      at: this.clock(), bootId: this.bootId, heapUsedBytes: memory.heapUsed,
      heapLimitBytes: getHeapStatistics().heap_size_limit, rssBytes: memory.rss,
      externalBytes: memory.external, arrayBufferBytes: memory.arrayBuffers,
      cpuPercent: Math.max(0, ((cpu.user - this.lastCpu.user) + (cpu.system - this.lastCpu.system)) / 1000 / Math.max(1, now - this.lastCpuAt) * 100),
      eventLoopMaxMs: this.lag.max / 1e6, gcCount: this.gcCount, gcDurationMs: this.gcDurationMs,
      queueDepth: queue?.waiting ?? 0, runningTools: queue?.running ?? 0,
      peakQueueDepth: queue?.peakQueueDepth ?? 0,
      maxQueueWaitMs: queue?.maxQueueWaitMs,
      processing: queue?.processing,
      requestsByTool: queue?.requestsByTool,
      timingsByTool: queue?.timingsByTool,
      queueDrops: queue?.queueDrops,
      operations: queue?.items.slice(0, 8) ?? [],
    };
    this.observability.runtime(sample);
    this.queue?.resetSamplingPeaks();
    this.lastCpu = cpu; this.lastCpuAt = now; this.gcCount = 0; this.gcDurationMs = 0;
  }

  history(limit = 60) {
    return this.observability?.enabled ? this.observability.history(limit) : [];
  }

  snapshot(activeSessions: number): InstanceDiagnostics {
    const memory = process.memoryUsage(), limit = getHeapStatistics().heap_size_limit;
    return {
      bootId: this.bootId, version: this.version, startedAt: this.startedAt, observedAt: this.clock(),
      runtime: { heapUsedBytes: memory.heapUsed, heapLimitBytes: limit, rssBytes: memory.rss,
        eventLoopMaxMs: this.lag.max / 1e6, activeRequests: this.activeRequests, activeSessions,
        admissionBlocked: memory.heapUsed >= limit * 0.6 },
      ...(this.observability?.enabled ? this.observability.httpSnapshot() : { minutes: [], callers: [], events: [] }),
      samples: this.history(),
      workQueue: this.queue ? { ...this.queue.state(), events: this.queue.events().slice(0, 5) } : undefined,
    };
  }

  close(): void {
    clearInterval(this.timer);
    this.gcObserver.disconnect();
    this.lag.disable();
    this.db.prepare('UPDATE instance_diagnostic_run SET clean=1 WHERE singleton=1 AND boot_id=?').run(this.bootId);
  }
}
