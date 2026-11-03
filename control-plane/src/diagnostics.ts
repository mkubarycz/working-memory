import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import type { InstanceDiagnostics } from './diagnosticContract.js';

const RETENTION_MS = 7 * 86400000;
const MAX_BUCKETS = 10000;
const MAX_EVENTS = 1000;

// Only known route shapes are retained, never user-controlled IDs, queries or headers.
export function diagnosticRoute(raw: string): string {
  const path = raw.split('?')[0];
  if (['/health', '/mcp', '/changes', '/attachments'].includes(path)) return path;
  if (/^\/attachments\/[^/]+$/.test(path)) return '/attachments/:id';
  if (path.startsWith('/identity/v1/')) return '/identity/v1/*';
  if (path.startsWith('/host-tasks/v1/')) return '/host-tasks/v1/*';
  if (/^\/features\/v[12]$/.test(path)) return path;
  if (path.startsWith('/oauth/') || path.startsWith('/.well-known/')) return '/oauth/*';
  return '/other';
}

export class HttpDiagnostics {
  readonly bootId = randomUUID();
  readonly startedAt: number;
  private activeRequests = 0;
  private bucketCount = 0;
  private eventCount = 0;
  private readonly lag = monitorEventLoopDelay({ resolution: 20 });
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly db: DatabaseSync, private readonly version: string, private readonly clock = Date.now) {
    this.startedAt = clock();
    db.exec(`
      CREATE TABLE IF NOT EXISTS instance_http_minutes (
        at INTEGER NOT NULL, caller TEXT NOT NULL, route TEXT NOT NULL, status INTEGER NOT NULL,
        count INTEGER NOT NULL, total_ms REAL NOT NULL, max_ms REAL NOT NULL,
        PRIMARY KEY(at,caller,route,status)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS instance_diagnostic_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, code TEXT NOT NULL,
        request_id TEXT, route TEXT NOT NULL, status INTEGER NOT NULL, duration_ms REAL NOT NULL,
        count INTEGER NOT NULL, bucket TEXT UNIQUE
      ) STRICT;
      CREATE TABLE IF NOT EXISTS instance_diagnostic_run (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), boot_id TEXT NOT NULL, clean INTEGER NOT NULL
      ) STRICT;
    `);
    const previous = db.prepare('SELECT clean FROM instance_diagnostic_run WHERE singleton=1').get();
    if (previous && previous.clean === 0) this.event('unclean_restart');
    db.prepare(`INSERT INTO instance_diagnostic_run VALUES(1,?,0)
      ON CONFLICT(singleton) DO UPDATE SET boot_id=excluded.boot_id,clean=0`).run(this.bootId);
    this.prune();
    this.lag.enable();
    this.timer = setInterval(() => {
      try {
        const lag = this.lag.max / 1e6;
        if (lag >= 1000) this.event('event_loop_stall', null, '/runtime', 0, lag, true);
        if (process.memoryUsage().heapUsed >= getHeapStatistics().heap_size_limit * 0.6) {
          this.event('memory_pressure', null, '/runtime', 503, 0, true);
        }
        this.prune();
        this.lag.reset();
      } catch (error) { console.error('[diagnostics] Runtime sampling failed:', error); }
    }, 10000);
    this.timer.unref();
  }

  track(req: IncomingMessage, res: ServerResponse, caller: () => string): void {
    const start = this.clock(), requestId = randomUUID(), route = diagnosticRoute(req.url ?? '/');
    res.setHeader('X-Request-Id', requestId);
    this.activeRequests += 1;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      this.activeRequests -= 1;
      const duration = Math.max(0, this.clock() - start), status = res.writableFinished ? res.statusCode : 499;
      try {
        const at = Math.floor(start / 60000) * 60000, identity = caller();
        const inserted = this.db.prepare('INSERT OR IGNORE INTO instance_http_minutes VALUES(?,?,?,?,1,?,?)')
          .run(at, identity, route, status, duration, duration);
        if (inserted.changes) {
          this.bucketCount += 1;
          if (this.bucketCount > MAX_BUCKETS) this.prune();
        } else {
          this.db.prepare(`UPDATE instance_http_minutes SET count=count+1,total_ms=total_ms+?,
            max_ms=MAX(max_ms,?) WHERE at=? AND caller=? AND route=? AND status=?`)
            .run(duration, duration, at, identity, route, status);
        }
        if (status >= 400 || duration >= 3000) {
          this.event(status >= 400 ? 'http_error' : 'slow_request', requestId, route, status, duration, true);
        }
      } catch (error) { console.error('[diagnostics] Request recording failed:', error); }
    };
    res.once('finish', finish);
    res.once('close', finish);
  }

  event(code: string, requestId: string | null = null, route = '/runtime', status = 0, duration = 0, aggregate = false): void {
    const at = this.clock(), bucket = aggregate ? `${Math.floor(at / 60000)}:${code}:${route}:${status}` : null;
    if (bucket) {
      const updated = this.db.prepare(`UPDATE instance_diagnostic_events SET at=?,count=count+1,
        request_id=?,duration_ms=MAX(duration_ms,?) WHERE bucket=?`).run(at, requestId, duration, bucket);
      if (updated.changes) return;
    }
    this.db.prepare(`INSERT INTO instance_diagnostic_events
      (at,code,request_id,route,status,duration_ms,count,bucket) VALUES(?,?,?,?,?,?,1,?)`)
      .run(at, code, requestId, route, status, duration, bucket);
    this.eventCount += 1;
    if (this.eventCount > MAX_EVENTS) this.prune();
  }

  private prune(): void {
    this.db.prepare('DELETE FROM instance_http_minutes WHERE at<?').run(this.clock() - RETENTION_MS);
    this.db.prepare(`DELETE FROM instance_http_minutes WHERE rowid IN
      (SELECT rowid FROM instance_http_minutes ORDER BY at DESC LIMIT -1 OFFSET ?)`).run(MAX_BUCKETS);
    this.db.prepare('DELETE FROM instance_diagnostic_events WHERE at<?').run(this.clock() - RETENTION_MS);
    this.db.prepare(`DELETE FROM instance_diagnostic_events WHERE sequence IN
      (SELECT sequence FROM instance_diagnostic_events ORDER BY sequence DESC LIMIT -1 OFFSET ?)`).run(MAX_EVENTS);
    this.bucketCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM instance_http_minutes').get()?.count);
    this.eventCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM instance_diagnostic_events').get()?.count);
  }

  snapshot(activeSessions: number): InstanceDiagnostics {
    const memory = process.memoryUsage(), limit = getHeapStatistics().heap_size_limit;
    return {
      bootId: this.bootId, version: this.version, startedAt: this.startedAt, observedAt: this.clock(),
      runtime: { heapUsedBytes: memory.heapUsed, heapLimitBytes: limit, rssBytes: memory.rss,
        eventLoopMaxMs: this.lag.max / 1e6, activeRequests: this.activeRequests, activeSessions,
        admissionBlocked: memory.heapUsed >= limit * 0.6 },
      minutes: this.db.prepare(`SELECT at,SUM(count) AS transactions,
        SUM(CASE WHEN status>=400 THEN count ELSE 0 END) AS errors,
        SUM(total_ms)/SUM(count) AS average_ms,MAX(max_ms) AS max_ms
        FROM instance_http_minutes WHERE at>=? GROUP BY at ORDER BY at DESC LIMIT 60`)
        .all(this.clock() - 3600000).map(row => ({
          at: Number(row.at), transactions: Number(row.transactions), errors: Number(row.errors),
          averageMs: Number(row.average_ms), maxMs: Number(row.max_ms),
        })),
      callers: this.db.prepare(`SELECT caller,route,status,SUM(count) AS transactions FROM instance_http_minutes
        WHERE at>=? GROUP BY caller,route,status ORDER BY transactions DESC LIMIT 100`)
        .all(this.clock() - 60000).map(row => ({
          caller: String(row.caller), route: String(row.route), status: Number(row.status), transactions: Number(row.transactions),
        })),
      events: this.db.prepare('SELECT * FROM instance_diagnostic_events ORDER BY sequence DESC LIMIT 100').all().map(row => ({
        sequence: Number(row.sequence), at: Number(row.at), code: String(row.code),
        requestId: row.request_id === null ? null : String(row.request_id), route: String(row.route),
        status: Number(row.status), durationMs: Number(row.duration_ms), count: Number(row.count),
      })),
    };
  }

  close(): void {
    clearInterval(this.timer);
    this.lag.disable();
    this.db.prepare('UPDATE instance_diagnostic_run SET clean=1 WHERE singleton=1 AND boot_id=?').run(this.bootId);
  }
}
