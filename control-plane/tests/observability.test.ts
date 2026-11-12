import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { Observability } from '../src/observability';
import { ToolQueue } from '../src/toolQueue';
import { HttpDiagnostics } from '../src/diagnostics';
import { EMBEDDING_MODEL, type EmbeddingDashboard } from '../src/embeddingContract';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const configuration = {
  endpoint: 'http://openobserve:5080', uiUrl: 'http://localhost:5080', username: 'wm@localhost.invalid',
  password: 'a generated private test password', claimId: randomUUID(),
};
function setup(enabled = true, fetcher: typeof fetch = vi.fn(async () => Response.json({ code: 200, status: [{ failed: 0 }] })),
  clock: () => number = Date.now) {
  const db = new DatabaseSync(':memory:');
  cleanup.push(() => db.close());
  const flags = { enabled };
  const exporter = new Observability(db, () => flags.enabled, { fetch: fetcher, clock, intervalMs: 60000 });
  cleanup.push(() => exporter.close());
  return { db, exporter, flags, fetcher };
}

it('exports cumulative histograms with distinct long-poll and ordinary labels and no caller IDs', async () => {
  const { exporter, fetcher } = setup();
  await exporter.configure(configuration);
  for (const route of ['/mcp', '/changes']) exporter.recordHttp({
    caller: `client:${randomUUID()}`, method: route === '/mcp' ? 'POST' : 'GET',
    route, status: 200, durationMs: 100, startedAt: Date.now(), streaming: false,
  });
  await exporter.flush();
  const call = vi.mocked(fetcher).mock.calls.find(([url]) => String(url).includes('/ingest/metrics/'))!;
  const rows = JSON.parse(String(call[1]?.body)) as Array<Record<string, unknown>>;
  const counts = rows.filter(row => row.__name__ === 'wm_http_request_duration_seconds_count');
  expect(counts).toEqual(expect.arrayContaining([
    expect.objectContaining({ request_class: 'ordinary', caller_type: 'client', value: 1 }),
    expect.objectContaining({ request_class: 'long_poll', caller_type: 'client', value: 1 }),
  ]));
  expect(rows.every(row => typeof row.value === 'number')).toBe(true);
  expect(JSON.stringify(rows)).not.toContain('client:');
  expect(exporter.status()).toMatchObject({ lastError: null, pendingLogs: 0, droppedLogs: 0 });
  expect(JSON.stringify(exporter.status())).not.toContain(configuration.password);
});

it('rechecks authorization before saving a connection after its network await', async () => {
  const { exporter } = setup();
  await expect(exporter.configure(configuration, () => { throw new Error('Owner session expired'); }))
    .rejects.toThrow('Owner session expired');
  expect(exporter.status().configured).toBe(false);
});

it('skips queue/runtime diagnostic SQLite inserts and pruning while retaining operational state', async () => {
  const { db, exporter, flags } = setup();
  const queue = new ToolQueue(db, () => false, Date.now, exporter);
  const diagnostics = new HttpDiagnostics(db, 'test', Date.now, queue, exporter);
  cleanup.push(() => diagnostics.close(), () => queue.close());
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'tool_queue%' OR name LIKE 'instance_%')").all();
  for (const { name } of tables) {
    if (typeof name !== 'string' || name.includes('settings') || name.includes('configuration') || name.includes('state')) continue;
    db.exec(`CREATE TEMP TRIGGER reject_insert_${name} BEFORE INSERT ON "${name}" BEGIN SELECT RAISE(ABORT,'diagnostic SQL insert'); END;
      CREATE TEMP TRIGGER reject_delete_${name} BEFORE DELETE ON "${name}" BEGIN SELECT RAISE(ABORT,'diagnostic SQL prune'); END`);
  }
  await queue.run({ requestId: randomUUID(), operation: 'wm-ping', caller: 'owner' }, {},
    new AbortController().signal, async () => 'ok');
  diagnostics.sample();
  expect(queue.state()).toMatchObject({ running: 0, waiting: 0 });
  expect(exporter.queueEvents(10).map(row => row.event)).toEqual(['completed', 'started']);
  expect(exporter.status().pendingLogs).toBe(2);
  expect(diagnostics.history().length).toBeGreaterThan(0);
  flags.enabled = false;
  for (const { name } of tables) if (typeof name === 'string') {
    db.exec(`DROP TRIGGER IF EXISTS reject_insert_${name}; DROP TRIGGER IF EXISTS reject_delete_${name}`);
  }
});

it('bounds outage logs, records lost batches, avoids concurrent exports and stops on disable', async () => {
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ code: 200, status: [] }));
  const { exporter, flags } = setup(true, fetcher);
  await exporter.configure(configuration);
  for (let i = 0; i < 20100; i++) exporter.event('http_error', null, '/mcp', 500, 1);
  expect(exporter.status()).toMatchObject({ pendingLogs: 20000, droppedLogs: 100 });
  fetcher.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  }));
  const first = exporter.flush();
  expect(exporter.flush()).toBe(first);
  flags.enabled = false;
  exporter.syncEnabled();
  await first;
  expect(exporter.status()).toMatchObject({ pendingLogs: 0, droppedLogs: 20100, lastError: null });
  expect(warning).not.toHaveBeenCalled();
});

function metricRows(fetcher: typeof fetch) {
  return vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).includes('/ingest/metrics/'))
    .map(([, init]) => JSON.parse(String(init?.body)) as Array<Record<string, unknown>>);
}

it('omits unavailable embeddings gauges and explicitly marks failed snapshots instead of retaining stale state', async () => {
  const { exporter, fetcher } = setup();
  await exporter.configure(configuration);
  const state: EmbeddingDashboard = {
    endpoint: 'http://127.0.0.1:7716', enabled: true, paused: false, phase: 'idle',
    model: EMBEDDING_MODEL, downloadBytes: 0, downloadTotal: 90871461, backend: 'CPU',
    warning: null, error: null, rssBytes: 1024, lastInferenceMs: 10, lastSuccessAtMs: null,
    stats: { total: 3, indexed: 2, pending: 1, limited: 1, vectorBytes: 4096, lastIndexedAt: 123 },
  };
  exporter.recordEmbeddingSnapshot(state);
  await exporter.flush();
  exporter.recordEmbeddingSnapshot({ ...state, rssBytes: null, stats: null, lastInferenceMs: null });
  await exporter.flush();
  expect(metricRows(fetcher).at(-1)).not.toEqual(expect.arrayContaining([
    expect.objectContaining({ __name__: 'wm_embeddings_model_rss_bytes' }),
  ]));
  expect(metricRows(fetcher).at(-1)).toEqual(expect.arrayContaining([
    expect.objectContaining({ __name__: 'wm_embeddings_model_memory_available', value: 0 }),
  ]));
  exporter.recordEmbeddingSnapshotFailure();
  await exporter.flush();
  expect(metricRows(fetcher).at(-1)).toEqual(expect.arrayContaining([
    expect.objectContaining({ __name__: 'wm_embeddings_snapshot_available', value: 0 }),
  ]));
  expect(metricRows(fetcher).at(-1)!.some(row => row.__name__ === 'wm_embeddings_phase')).toBe(false);
});

it('retains all observed GC intervals across exports and includes external memory', async () => {
  const { exporter, fetcher } = setup();
  await exporter.configure(configuration);
  const sample = {
    at: Date.now(), bootId: exporter.bootId, heapUsedBytes: 1024, heapLimitBytes: 4096,
    rssBytes: 2048, externalBytes: 512, arrayBufferBytes: 256, cpuPercent: 125,
    eventLoopMaxMs: 30, gcCount: 0, gcDurationMs: 0, queueDepth: 2, runningTools: 4, operations: [],
  };
  exporter.runtime(sample);
  await exporter.flush();
  exporter.runtime({ ...sample, gcCount: 3, gcDurationMs: 15 });
  exporter.runtime({ ...sample, gcCount: 2, gcDurationMs: 5 });
  await exporter.flush();
  const expected = [
    expect.objectContaining({ __name__: 'wm_gc_collections_total', value: 5 }),
    expect.objectContaining({ __name__: 'wm_gc_duration_seconds_total', value: 0.02 }),
    expect.objectContaining({ __name__: 'wm_process_external_memory_bytes', value: 512 }),
    expect.objectContaining({ __name__: 'wm_process_cpu_ratio', value: 1.25 }),
    expect.objectContaining({ __name__: 'wm_tool_queue_depth', value: 2 }),
    expect.objectContaining({ __name__: 'wm_tool_running', value: 4 }),
  ];
  expect(metricRows(fetcher).at(-1)).toEqual(expect.arrayContaining(expected));
  await exporter.flush();
  expect(metricRows(fetcher).at(-1)).toEqual(expect.arrayContaining(expected));
});

it('exports zero-initialized HTTP totals so a newly seen error status contributes to rates', async () => {
  const { exporter, fetcher } = setup();
  await exporter.configure(configuration);
  await exporter.flush();
  expect(metricRows(fetcher).at(-1)).toEqual(expect.arrayContaining([
    expect.objectContaining({ __name__: 'wm_http_requests_total', value: 0 }),
    expect.objectContaining({ __name__: 'wm_http_errors_total', value: 0 }),
  ]));
  exporter.recordHttp({ caller: 'owner', method: 'POST', route: '/new-route', status: 500,
    durationMs: 250, startedAt: Date.now(), streaming: false });
  await exporter.flush();
  expect(metricRows(fetcher).at(-1)).toEqual(expect.arrayContaining([
    expect.objectContaining({ __name__: 'wm_http_requests_total', value: 1 }),
    expect.objectContaining({ __name__: 'wm_http_errors_total', value: 1 }),
    expect.objectContaining({ __name__: 'wm_http_duration_seconds_total', value: 0.25 }),
    expect.objectContaining({ __name__: 'wm_http_max_duration_seconds', value: 0.25 }),
  ]));
});

it('exports scoped lifecycle logs, acknowledged log rates and request/drop counters through the production queue entry point', async () => {
  const { db, exporter, fetcher } = setup();
  await exporter.configure(configuration);
  const queue = new ToolQueue(db, () => false, Date.now, exporter);
  const diagnostics = new HttpDiagnostics(db, 'test', Date.now, queue, exporter);
  cleanup.push(() => diagnostics.close(), () => queue.close());
  const requestId = randomUUID();
  await queue.run({ requestId, operation: 'wm-ping', caller: 'owner' }, { private: 'never export payloads' },
    new AbortController().signal, async () => 'ok');
  diagnostics.sample();
  exporter.event('http_error', requestId, '/mcp', 500, 5);
  await exporter.flush();
  await exporter.flush();
  const logs = vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).endsWith('/wm_diagnostics/_json'))
    .flatMap(([, init]) => JSON.parse(String(init?.body)) as Array<Record<string, unknown>>);
  expect(logs.filter(row => row.source === 'queue')).toEqual([
    expect.objectContaining({ source: 'queue', event: 'started', phase: 'started', request_id: requestId }),
    expect.objectContaining({ source: 'queue', event: 'completed', phase: 'finished', wait_ms: 0 }),
  ]);
  expect(logs.find(row => row.source === 'http')).toMatchObject({ request_id: requestId, status: 500 });
  expect(JSON.stringify(logs)).not.toContain('never export payloads');
  expect(metricRows(fetcher).at(-1)).toEqual(expect.arrayContaining([
    expect.objectContaining({ __name__: 'wm_tool_requests_total', tool: 'wm-ping', value: 1 }),
    expect.objectContaining({ __name__: 'wm_tool_queue_drops_total', reason: 'timeouts', value: 0 }),
    expect.objectContaining({ __name__: 'wm_diagnostic_logs_exported_total', source: 'queue', value: 2 }),
    expect.objectContaining({ __name__: 'wm_diagnostic_logs_exported_total', source: 'http', value: 1 }),
  ]));
});

it('exports interval HTTP maxima, preserves peaks after failed ingestion and retains cumulative counts', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { exporter, fetcher } = setup();
  await exporter.configure(configuration);
  const request = (durationMs: number) => exporter.recordHttp({
    caller: 'owner', method: 'GET', route: '/health', status: 200,
    durationMs, startedAt: Date.now(), streaming: false,
  });
  request(1000);
  await exporter.flush();
  request(10);
  await exporter.flush();
  expect(metricRows(fetcher).at(-1)!.find(row => row.__name__ === 'wm_http_request_duration_seconds_max')!.value).toBe(.01);
  expect(metricRows(fetcher).at(-1)!.find(row => row.__name__ === 'wm_http_request_duration_seconds_count')!.value).toBe(2);
  request(500);
  vi.mocked(fetcher).mockResolvedValueOnce(new Response('', { status: 503 }));
  await exporter.flush();
  request(20);
  await exporter.flush();
  expect(metricRows(fetcher).at(-1)!.find(row => row.__name__ === 'wm_http_request_duration_seconds_max')!.value).toBe(.5);
  await exporter.flush();
  expect(metricRows(fetcher).at(-1)!.find(row => row.__name__ === 'wm_http_request_duration_seconds_max')!.value).toBe(0);
});

it('drains high-volume logs in bounded asynchronous batches without exporting metric snapshots for every batch', async () => {
  const { exporter, fetcher } = setup();
  await exporter.configure(configuration);
  for (let i = 0; i < 5000; i++) exporter.recordQueue({
    at: Date.now(), requestId: randomUUID(), operation: 'wm-ping', caller: 'owner', event: 'completed',
    waiting: 0, running: 0, waitMs: 0, runMs: 1,
  });
  await new Promise<void>(resolve => setImmediate(resolve));
  await exporter.flush(false);
  expect(metricRows(fetcher)).toHaveLength(1);
  await exporter.flush();
  const batches = vi.mocked(fetcher).mock.calls.filter(([url]) => String(url).endsWith('/wm_diagnostics/_json'))
    .map(([, init]) => JSON.parse(String(init?.body)) as unknown[]);
  expect(batches.every(batch => batch.length <= 2000)).toBe(true);
  expect(batches.flat()).toHaveLength(5000);
  expect(exporter.status()).toMatchObject({ pendingLogs: 0, droppedLogs: 0, lastError: null });
});
