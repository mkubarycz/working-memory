import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { runtimeSampleSchema, toolQueueSnapshotSchema } from './diagnosticContract.js';
import type { EmbeddingDashboard } from './embeddingContract.js';

const origin = z.string().url().max(2048).refine(raw => {
  const url = new URL(raw);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === '/';
}, 'Use an HTTP(S) origin without credentials, a path, query or fragment.');
export const observabilityConfigurationSchema = z.object({
  endpoint: origin,
  uiUrl: origin.refine(raw => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(raw).hostname)),
  username: z.string().email().max(254),
  password: z.string().min(16).max(1024),
  claimId: z.string().uuid(),
  organization: z.literal('default').default('default'),
  retentionDays: z.literal(7).default(7),
}).strict();
export type ObservabilityConfiguration = z.infer<typeof observabilityConfigurationSchema>;
export class ObservabilityConnectionError extends Error {}
export const observabilityStatusSchema = z.object({
  enabled: z.boolean(), configured: z.boolean(), uiUrl: z.string().nullable(), claimId: z.string().uuid().nullable(),
  retentionDays: z.literal(7), exportIntervalMs: z.number(), lastSuccessAt: z.number().nullable(),
  lastError: z.string().nullable(), pendingLogs: z.number(), droppedLogs: z.number(), droppedSeries: z.number(),
});
export type ObservabilityStatus = z.infer<typeof observabilityStatusSchema>;
type RuntimeSample = z.infer<typeof runtimeSampleSchema>;
type QueueEvent = z.infer<typeof toolQueueSnapshotSchema>['events'][number];
type Labels = Record<string, string>;
interface Histogram { name: string; labels: Labels; count: number; sum: number; max: number; buckets: number[] }
interface HttpMinute {
  at: number; caller: string; route: string; status: number; count: number; totalMs: number; maxMs: number;
}
interface DiagnosticEvent {
  sequence: number; at: number; code: string; requestId: string | null;
  route: string; status: number; durationMs: number; count: number;
}
const BOUNDS = [.001, .005, .01, .025, .05, .1, .25, .5, 1, 2.5, 5, 10, 30, Infinity];
const MAX_SERIES = 512;
const LOG_BATCH_SIZE = 2000;
const LOG_BUFFER_SIZE = 20000;
type LogSource = 'http' | 'queue' | 'runtime' | 'embeddings';
export type EmbeddingOperation = 'index' | 'search';
export type EmbeddingOutcome = 'completed' | 'failed' | 'cancelled' | 'superseded';
interface DiagnosticLog extends Record<string, string | number | null> { source: LogSource }
const role = (caller: string) => caller.startsWith('client:') ? 'client' : caller === 'owner' ? 'owner' : 'unauthenticated';

/** Diagnostic data only. Business/audit documents never enter this exporter. */
export class Observability {
  readonly bootId = randomUUID();
  private configuration: ObservabilityConfiguration | null;
  private readonly histograms = new Map<string, Histogram>();
  private readonly gauges = new Map<string, number>();
  private readonly queueRows = new Map<number, QueueEvent>();
  private readonly seconds = new Map<number, { count: number; waitMs: number; runMs: number }>();
  private readonly http = new Map<string, HttpMinute>();
  private readonly diagnosticEvents = new Map<number, DiagnosticEvent>();
  private readonly samples: RuntimeSample[] = [];
  private readonly logs: DiagnosticLog[] = [];
  private readonly exportedLogs: Record<LogSource, number> = { http: 0, queue: 0, runtime: 0, embeddings: 0 };
  private readonly embeddingOperations = {
    index: { completed: 0, failed: 0, cancelled: 0, superseded: 0 },
    search: { completed: 0, failed: 0, cancelled: 0, superseded: 0 },
  };
  private embeddingPhase?: EmbeddingDashboard['phase'];
  private readonly toolRequests = new Map<string, number>();
  private queueDrops = { timeouts: 0, rejections: 0, shutdown: 0 };
  private lastMetricsAt = -Infinity;
  private httpTotals = { requests: 0, errors: 0, durationSeconds: 0 };
  private httpPeak = 0;
  private gcTotals = { count: 0, durationSeconds: 0 };
  private scheduledFlush: ReturnType<typeof setImmediate> | undefined;
  private closing = false;
  private sequence = 0;
  private droppedLogs = 0;
  private droppedSeries = 0;
  private lastSuccessAt: number | null = null;
  private lastError: string | null = null;
  private lastWarningAt = -Infinity;
  private flushing: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly db: DatabaseSync, private readonly isEnabled: () => boolean,
    private readonly options: { fetch?: typeof fetch; clock?: () => number; intervalMs?: number } = {}) {
    db.exec(`CREATE TABLE IF NOT EXISTS instance_observability_configuration (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), configuration TEXT NOT NULL
    ) STRICT`);
    const saved = db.prepare('SELECT configuration FROM instance_observability_configuration WHERE singleton=1').get();
    this.configuration = saved ? observabilityConfigurationSchema.parse(JSON.parse(String(saved.configuration))) : null;
    for (const operation of ['index', 'search'] as const) {
      for (const outcome of ['completed', 'failed', 'cancelled', 'superseded']) {
        this.histogram('wm_embeddings_operation_duration_seconds', { operation, outcome });
      }
      for (const stage of ['inference', 'host', 'startup', operation === 'index' ? 'submit' : 'ranking']) {
        this.histogram('wm_embeddings_stage_duration_seconds', { operation, stage });
      }
    }
    this.timer = setInterval(() => { void this.flush(); }, options.intervalMs ?? 10000);
    this.timer.unref();
  }

  get enabled(): boolean { return this.isEnabled(); }
  private now(): number { return (this.options.clock ?? Date.now)(); }

  status(): ObservabilityStatus {
    return {
      enabled: this.enabled, configured: this.configuration !== null,
      uiUrl: this.configuration?.uiUrl ?? null, claimId: this.configuration?.claimId ?? null,
      retentionDays: 7, exportIntervalMs: this.options.intervalMs ?? 10000,
      lastSuccessAt: this.lastSuccessAt, lastError: this.lastError,
      pendingLogs: this.logs.length, droppedLogs: this.droppedLogs, droppedSeries: this.droppedSeries,
    };
  }

  async configure(input: unknown, authorize: () => void = () => {}): Promise<ObservabilityStatus> {
    const configuration = observabilityConfigurationSchema.parse(input);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(
        new URL(`/api/${configuration.organization}/streams?type=logs`, configuration.endpoint), {
          headers: { Authorization: this.authorization(configuration) },
          signal: AbortSignal.timeout(5000), redirect: 'error',
        });
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof DOMException)) throw error;
      throw new ObservabilityConnectionError('OpenObserve connection failed. Check container health and network connectivity.');
    }
    await response.body?.cancel();
    if (!response.ok) throw new ObservabilityConnectionError(`OpenObserve connection check returned HTTP ${response.status}.`);
    authorize();
    this.db.prepare(`INSERT INTO instance_observability_configuration VALUES(1,?)
      ON CONFLICT(singleton) DO UPDATE SET configuration=excluded.configuration`).run(JSON.stringify(configuration));
    this.configuration = configuration;
    this.lastError = null;
    return this.status();
  }

  syncEnabled(): void {
    if (!this.enabled) {
      this.controller?.abort();
      this.droppedLogs += this.logs.length;
      this.logs.length = 0;
    }
  }

  private histogram(name: string, labels: Labels): Histogram | undefined {
    const key = `${name}:${JSON.stringify(labels)}`;
    let histogram = this.histograms.get(key);
    if (!histogram) {
      if (this.histograms.size >= MAX_SERIES) { this.droppedSeries++; return undefined; }
      histogram = { name, labels, count: 0, sum: 0, max: 0, buckets: BOUNDS.map(() => 0) };
      this.histograms.set(key, histogram);
    }
    return histogram;
  }

  private observe(name: string, labels: Labels, seconds: number): void {
    const histogram = this.histogram(name, labels);
    if (!histogram) return;
    histogram.count++;
    histogram.sum += seconds;
    histogram.max = Math.max(histogram.max, seconds);
    for (let i = 0; i < BOUNDS.length; i++) if (seconds <= BOUNDS[i]) histogram.buckets[i]++;
  }

  recordHttp(input: {
    caller: string; method: string; route: string; status: number; durationMs: number; startedAt: number; streaming: boolean;
  }): void {
    this.httpTotals.requests++;
    if (input.status >= 400) this.httpTotals.errors++;
    this.httpTotals.durationSeconds += input.durationMs / 1000;
    this.httpPeak = Math.max(this.httpPeak, input.durationMs / 1000);
    const caller = role(input.caller);
    const requestClass = input.route === '/changes' && input.method === 'GET' ? 'long_poll'
      : input.streaming ? 'stream' : 'ordinary';
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(input.method) ? input.method : 'OTHER';
    this.observe('wm_http_request_duration_seconds',
      { route: input.route, method, status: String(input.status), caller_type: caller, request_class: requestClass },
      input.durationMs / 1000);
    const at = Math.floor(input.startedAt / 60000) * 60000;
    const key = `${at}:${caller}:${input.route}:${input.status}`;
    const row = this.http.get(key) ?? { at, caller, route: input.route, status: input.status, count: 0, totalMs: 0, maxMs: 0 };
    row.count++; row.totalMs += input.durationMs; row.maxMs = Math.max(row.maxMs, input.durationMs);
    this.http.set(key, row);
    if (this.http.size > 10000) this.http.delete(this.http.keys().next().value!);
  }

  recordQueue(input: Omit<QueueEvent, 'sequence'>): void {
    const row = { ...input, caller: role(input.caller), sequence: ++this.sequence };
    this.queueRows.set(row.sequence, row);
    if (this.queueRows.size > 2000) this.queueRows.delete(this.queueRows.keys().next().value!);
    this.log('queue', {
      _timestamp: input.at, event: input.event, phase: input.event === 'queued' || input.event === 'started' ? input.event : 'finished',
      tool: input.operation, request_id: input.requestId, caller_type: role(input.caller),
      waiting: input.waiting, running: input.running, wait_ms: input.waitMs, run_ms: input.runMs,
    });
    if (!['completed', 'failed', 'not_executed', 'full', 'expired', 'cancelled', 'shutdown'].includes(input.event)) return;
    const labels = { tool: input.operation, outcome: input.event };
    this.observe('wm_tool_queue_wait_seconds', labels, input.waitMs / 1000);
    if (input.event === 'completed' || input.event === 'failed') {
      this.observe('wm_tool_execution_seconds', labels, input.runMs / 1000);
      const second = Math.floor(input.at / 1000) * 1000;
      const aggregate = this.seconds.get(second) ?? { count: 0, waitMs: 0, runMs: 0 };
      aggregate.count++; aggregate.waitMs += input.waitMs; aggregate.runMs += input.runMs;
      this.seconds.set(second, aggregate);
      for (const at of this.seconds.keys()) if (at < second - 60000) this.seconds.delete(at);
    }
  }

  queueEvents(limit: number): QueueEvent[] { return [...this.queueRows.values()].reverse().slice(0, limit); }

  processing() {
    const second = Math.floor(this.now() / 1000) * 1000;
    let count = 0, recent = 0, waitMs = 0, runMs = 0;
    for (const [at, row] of this.seconds) {
      if (at <= second - 60000 || at > second) continue;
      count += row.count; waitMs += row.waitMs; runMs += row.runMs;
      if (at > second - 10000) recent += row.count;
    }
    return { processedPerSecond: recent / 10, processedLastMinute: count,
      averageWaitMs: count ? waitMs / count : null, averageRunMs: count ? runMs / count : null };
  }

  event(code: string, requestId: string | null, route: string, status: number, durationMs: number): void {
    const row = { sequence: ++this.sequence, at: this.now(), code, requestId, route, status, durationMs, count: 1 };
    this.diagnosticEvents.set(row.sequence, row);
    if (this.diagnosticEvents.size > 1000) this.diagnosticEvents.delete(this.diagnosticEvents.keys().next().value!);
    this.log(route === '/runtime' ? 'runtime' : 'http',
      { _timestamp: row.at, event: code, request_id: requestId, route, status, duration_ms: durationMs });
  }

  private log(source: LogSource, row: Record<string, string | number | null>): void {
    if (this.logs.length >= LOG_BUFFER_SIZE) { this.droppedLogs++; return; }
    this.logs.push({ ...row, source });
    this.scheduleLogFlush();
  }

  private scheduleLogFlush(): void {
    if (this.closing || this.scheduledFlush || this.flushing || !this.configuration || !this.enabled || this.logs.length < LOG_BATCH_SIZE) return;
    this.scheduledFlush = setImmediate(() => {
      this.scheduledFlush = undefined;
      void this.flush(false);
    });
    this.scheduledFlush.unref();
  }

  recordEmbeddingSnapshot(state: EmbeddingDashboard): void {
    if (!this.enabled) return;
    if (this.embeddingPhase !== state.phase) {
      this.log('embeddings', { _timestamp: this.now(), event: 'state_changed', phase: state.phase });
    }
    this.embeddingPhase = state.phase;
    const values: Record<string, number | null> = {
      wm_embeddings_snapshot_available: 1,
      wm_embeddings_enabled: Number(state.enabled),
      wm_embeddings_error: Number(!!state.error),
      wm_embeddings_model_memory_available: Number(state.rssBytes !== null),
      wm_embeddings_model_rss_bytes: state.rssBytes,
      wm_embeddings_download_bytes: state.downloadBytes,
      wm_embeddings_download_total_bytes: state.downloadTotal,
      wm_embeddings_documents: state.stats?.total ?? null,
      wm_embeddings_indexed_documents: state.stats?.indexed ?? null,
      wm_embeddings_pending_documents: state.stats?.pending ?? null,
      wm_embeddings_limited_documents: state.stats?.limited ?? null,
      wm_embeddings_vector_bytes: state.stats?.vectorBytes ?? null,
      wm_embeddings_last_indexed_timestamp_seconds: state.stats?.lastIndexedAt ?? null,
      wm_embeddings_last_inference_seconds: state.lastInferenceMs === null ? null : state.lastInferenceMs / 1000,
    };
    for (const [name, value] of Object.entries(values)) {
      if (value === null) this.gauges.delete(name);
      else this.gauges.set(name, value);
    }
  }

  recordEmbeddingSnapshotFailure(): void {
    if (!this.enabled) return;
    for (const name of this.gauges.keys()) if (name.startsWith('wm_embeddings_')) this.gauges.delete(name);
    this.embeddingPhase = undefined;
    this.gauges.set('wm_embeddings_snapshot_available', 0);
    this.log('embeddings', { _timestamp: this.now(), event: 'snapshot_failed' });
  }

  recordEmbeddingOperation(operation: EmbeddingOperation, outcome: EmbeddingOutcome, durationMs: number): void {
    if (!this.enabled) return;
    this.embeddingOperations[operation][outcome]++;
    this.observe('wm_embeddings_operation_duration_seconds', { operation, outcome }, durationMs / 1000);
    this.log('embeddings', { _timestamp: this.now(), event: `${operation}_${outcome}`, operation, outcome, duration_ms: durationMs });
  }

  recordEmbeddingTiming(operation: EmbeddingOperation, stage: 'inference' | 'host' | 'startup' | 'ranking' | 'submit',
    durationMs: number): void {
    if (this.enabled) this.observe('wm_embeddings_stage_duration_seconds', { operation, stage }, durationMs / 1000);
  }

  runtime(sample: RuntimeSample): void {
    this.samples.unshift(sample);
    this.samples.length = Math.min(this.samples.length, 180);
    this.gcTotals.count += sample.gcCount;
    this.gcTotals.durationSeconds += sample.gcDurationMs / 1000;
    const values: Record<string, number> = {
      wm_process_heap_used_bytes: sample.heapUsedBytes, wm_process_heap_limit_bytes: sample.heapLimitBytes,
      wm_process_resident_memory_bytes: sample.rssBytes, wm_process_cpu_ratio: sample.cpuPercent / 100,
      wm_process_external_memory_bytes: sample.externalBytes,
      wm_event_loop_delay_max_seconds: sample.eventLoopMaxMs / 1000,
      wm_gc_count_interval: sample.gcCount, wm_gc_duration_interval_seconds: sample.gcDurationMs / 1000,
      wm_gc_collections_total: this.gcTotals.count, wm_gc_duration_seconds_total: this.gcTotals.durationSeconds,
      wm_tool_queue_depth: sample.queueDepth, wm_tool_running: sample.runningTools,
      wm_tool_queue_peak_depth: sample.peakQueueDepth ?? sample.queueDepth,
      wm_tool_queue_max_wait_seconds: (sample.maxQueueWaitMs ?? 0) / 1000,
    };
    for (const [key, value] of Object.entries(values)) this.gauges.set(key, value);
    for (const [tool, count] of Object.entries(sample.requestsByTool ?? {})) {
      if (!this.toolRequests.has(tool) && this.toolRequests.size >= MAX_SERIES) { this.droppedSeries++; continue; }
      this.toolRequests.set(tool, count);
    }
    if (sample.queueDrops) this.queueDrops = { ...sample.queueDrops };
  }

  history(limit: number): RuntimeSample[] { return this.samples.slice(0, limit); }

  httpSnapshot() {
    const minutes = new Map<number, { at: number; transactions: number; errors: number; totalMs: number; maxMs: number }>();
    const callers = new Map<string, { caller: string; route: string; status: number; transactions: number }>();
    for (const row of this.http.values()) {
      if (row.at < this.now() - 3600000) continue;
      const minute = minutes.get(row.at) ?? { at: row.at, transactions: 0, errors: 0, totalMs: 0, maxMs: 0 };
      minute.transactions += row.count; minute.errors += row.status >= 400 ? row.count : 0;
      minute.totalMs += row.totalMs; minute.maxMs = Math.max(minute.maxMs, row.maxMs);
      minutes.set(row.at, minute);
      if (row.at < this.now() - 60000) continue;
      const key = `${row.caller}:${row.route}:${row.status}`;
      const caller = callers.get(key) ?? { caller: row.caller, route: row.route, status: row.status, transactions: 0 };
      caller.transactions += row.count; callers.set(key, caller);
    }
    return {
      minutes: [...minutes.values()].sort((a, b) => b.at - a.at)
        .map(({ totalMs, ...row }) => ({ ...row, averageMs: totalMs / row.transactions })),
      callers: [...callers.values()].sort((a, b) => b.transactions - a.transactions).slice(0, 100),
      events: [...this.diagnosticEvents.values()].reverse().slice(0, 100),
    };
  }

  private authorization(configuration: ObservabilityConfiguration): string {
    return `Basic ${Buffer.from(`${configuration.username}:${configuration.password}`).toString('base64')}`;
  }

  private async send(configuration: ObservabilityConfiguration, path: string, rows: unknown[], signal: AbortSignal): Promise<void> {
    const response = await (this.options.fetch ?? fetch)(new URL(path, configuration.endpoint), {
      method: 'POST', headers: { Authorization: this.authorization(configuration), 'Content-Type': 'application/json' },
      body: JSON.stringify(rows), signal, redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`OpenObserve ingestion returned HTTP ${response.status}.`); }
    const result = z.object({ code: z.number(), status: z.array(z.object({ failed: z.number() })) }).parse(await response.json());
    if (result.code !== 200 || result.status.some(stream => stream.failed > 0)) throw new Error('OpenObserve rejected telemetry records.');
  }

  flush(forceMetrics = true): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.enabled) { this.syncEnabled(); return Promise.resolve(); }
    const configuration = this.configuration;
    if (!configuration) {
      this.lastError = 'Observability is enabled but its OpenObserve connection is not configured.';
      return Promise.resolve();
    }
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(5000)]);
    const at = this.now(), labels = { service: 'working-memory', instance: this.bootId };
    const metrics: Record<string, string | number>[] = [];
    const exportMetrics = forceMetrics || at - this.lastMetricsAt >= (this.options.intervalMs ?? 10000);
    const peaks: Array<{ histogram: Histogram; max: number }> = [];
    const httpPeak = this.httpPeak;
    if (exportMetrics) {
      this.httpPeak = 0;
      for (const histogram of this.histograms.values()) {
        for (let i = 0; i < BOUNDS.length; i++) metrics.push({
          __name__: `${histogram.name}_bucket`, __type__: 'counter', ...labels, ...histogram.labels,
          le: Number.isFinite(BOUNDS[i]) ? String(BOUNDS[i]) : '+Inf', _timestamp: at, value: histogram.buckets[i],
        });
        for (const [suffix, value] of [['_count', histogram.count], ['_sum', histogram.sum]] as const) {
          metrics.push({ __name__: `${histogram.name}${suffix}`, __type__: 'counter',
            ...labels, ...histogram.labels, _timestamp: at, value });
        }
        metrics.push({ __name__: `${histogram.name}_max`, __type__: 'gauge',
          ...labels, ...histogram.labels, _timestamp: at, value: histogram.max });
        peaks.push({ histogram, max: histogram.max });
        histogram.max = 0;
      }
      const gauges: Array<[string, number]> = [...this.gauges,
        ['wm_telemetry_dropped_logs_total', this.droppedLogs], ['wm_telemetry_dropped_series_total', this.droppedSeries]];
      gauges.push(['wm_http_requests_total', this.httpTotals.requests], ['wm_http_errors_total', this.httpTotals.errors],
        ['wm_http_duration_seconds_total', this.httpTotals.durationSeconds], ['wm_http_max_duration_seconds', httpPeak]);
      for (const [name, value] of gauges) {
        metrics.push({ __name__: name, __type__: name.endsWith('_total') ? 'counter' : 'gauge',
          ...labels, _timestamp: at, value });
      }
      for (const [tool, value] of this.toolRequests) metrics.push({
        __name__: 'wm_tool_requests_total', __type__: 'counter', ...labels, tool, _timestamp: at, value,
      });
      for (const [operation, outcomes] of Object.entries(this.embeddingOperations)) {
        for (const [outcome, value] of Object.entries(outcomes)) metrics.push({
          __name__: 'wm_embeddings_operations_total', __type__: 'counter', ...labels, operation, outcome, _timestamp: at, value,
        });
      }
      if (this.embeddingPhase) {
        for (const phase of ['disabled', 'paused', 'downloading', 'starting', 'indexing', 'idle', 'error']) metrics.push({
          __name__: 'wm_embeddings_phase', __type__: 'gauge', ...labels, phase, _timestamp: at,
          value: Number(phase === this.embeddingPhase),
        });
      }
      for (const [reason, value] of Object.entries(this.queueDrops)) metrics.push({
        __name__: 'wm_tool_queue_drops_total', __type__: 'counter', ...labels, reason, _timestamp: at, value,
      });
      for (const [source, value] of Object.entries(this.exportedLogs)) metrics.push({
        __name__: 'wm_diagnostic_logs_exported_total', __type__: 'counter', ...labels, source, _timestamp: at, value,
      });
    }
    const logs = this.logs.splice(0, LOG_BATCH_SIZE).map(row => ({ ...labels, ...row }));
    if (!exportMetrics && !logs.length) { this.controller = undefined; return Promise.resolve(); }
    let metricsSent = false, succeeded = false;
    this.flushing = (async () => {
      try {
        if (exportMetrics) {
          await this.send(configuration, `/api/${configuration.organization}/ingest/metrics/_json`, metrics, signal);
          metricsSent = true;
          this.lastMetricsAt = at;
        }
        if (logs.length) {
          await this.send(configuration, `/api/${configuration.organization}/wm_diagnostics/_json`, logs, signal);
          for (const row of logs) this.exportedLogs[row.source]++;
        }
        this.lastSuccessAt = this.now(); this.lastError = null;
        succeeded = true;
      } catch (error) {
        if (!metricsSent) {
          for (const peak of peaks) peak.histogram.max = Math.max(peak.histogram.max, peak.max);
          if (exportMetrics) this.httpPeak = Math.max(this.httpPeak, httpPeak);
        }
        this.droppedLogs += logs.length;
        const detail = error instanceof z.ZodError ? 'Invalid ingestion acknowledgement.'
          : error instanceof Error && /^OpenObserve (ingestion|rejected)/.test(error.message) ? error.message
            : 'Collector connection failed or timed out.';
        this.lastError = this.enabled
          ? `OpenObserve export failed. ${detail} Diagnostic logs in this batch were dropped; cumulative metrics will be retried.`
          : null;
        if (this.lastError && this.now() - this.lastWarningAt >= 60000) {
          console.error(`[observability] ${this.lastError}`);
          this.lastWarningAt = this.now();
        }
      } finally {
        this.flushing = undefined; this.controller = undefined;
        if (succeeded) this.scheduleLogFlush();
      }
    })();
    return this.flushing;
  }

  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    if (this.scheduledFlush) clearImmediate(this.scheduledFlush);
    const deadline = Date.now() + 5000;
    await this.flushing;
    do { await this.flush(); } while (this.logs.length && this.lastError === null && Date.now() < deadline);
    if (this.logs.length) {
      this.droppedLogs += this.logs.length;
      console.error(`[observability] Dropped ${this.logs.length} remaining diagnostic logs during shutdown.`);
      this.logs.length = 0;
    }
  }
}
