import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { InstanceIdentity } from '../src/instanceIdentity';
import { InstanceAccess } from '../src/instanceAccess';
import { startServer } from '../src/server';
import { diagnosticsSchema } from '../src/diagnosticContract';
import { diagnosticRoute, HttpDiagnostics } from '../src/diagnostics';
import { openStore } from '../src/store';
import { loadKinds } from '../src/kinds/loader';
import { SERVICE_VERSION } from '../src/config';
import { DOCUMENT_CHANGE_POLL_TIMEOUT_MS } from '../src/documentChangeFeed';
import { ToolQueue } from '../src/toolQueue';
import { Observability } from '../src/observability';
import { InstanceFeatureStore } from '../src/instanceFeatures';
import { PerformanceObserver } from 'node:perf_hooks';

const cleanup: Array<() => Promise<void> | void> = [];
beforeAll(() => loadKinds());
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); vi.restoreAllMocks(); });

function observer(db: DatabaseSync, clock = Date.now) {
  const flags = { enabled: true };
  const exporter = new Observability(db, () => flags.enabled, { clock, intervalMs: 2_000_000_000 });
  cleanup.push(() => {
    flags.enabled = false;
    exporter.syncEnabled();
    return exporter.close();
  });
  return exporter;
}

it('records runtime and operation trends without request arguments, and accepts legacy diagnostics without the new fields', async () => {
  const db = new DatabaseSync(':memory:'), controller = new AbortController();
  const exporter = observer(db);
  const queue = new ToolQueue(db, () => true, Date.now, exporter);
  const diagnostics = new HttpDiagnostics(db, '1.4.1', Date.now, queue, exporter);
  cleanup.push(() => db.close(), () => diagnostics.close(), () => queue.close());
  const pending = queue.run({ requestId: randomUUID(), operation: 'wm-document-query', caller: 'owner' },
    { query: 'PRIVATE_QUERY', body: 'PRIVATE_DOCUMENT', token: 'PRIVATE_TOKEN' }, controller.signal, async () => {});
  const cancelled = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  diagnostics.sample();
  const snapshot = diagnostics.snapshot(1);
  expect(snapshot.samples?.[0]).toMatchObject({ queueDepth: 1, runningTools: 0,
    requestsByTool: { 'wm-document-query': 1 },
    processing: { processedPerSecond: 0, processedLastMinute: 0, averageWaitMs: null, averageRunMs: null },
    operations: [expect.objectContaining({ operation: 'wm-document-query' })] });
  expect(snapshot.samples?.[0].cpuPercent).toBeGreaterThanOrEqual(0);
  expect(snapshot.samples?.[0].gcCount).toBeGreaterThanOrEqual(0);
  expect(snapshot.samples?.[0].rssBytes).toBeGreaterThan(0);
  for (const value of ['PRIVATE_QUERY', 'PRIVATE_DOCUMENT', 'PRIVATE_TOKEN']) {
    expect(JSON.stringify(snapshot)).not.toContain(value);
    expect(JSON.stringify(exporter.queueEvents(100))).not.toContain(value);
  }
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('instance_runtime_samples','instance_tool_queue_events','instance_tool_queue_seconds')").all()).toEqual([]);
  const { samples, workQueue, ...legacy } = snapshot;
  expect(diagnosticsSchema.parse(legacy).samples).toBeUndefined();
  expect(samples).toHaveLength(2);
  expect(workQueue?.waiting).toBe(1);
  expect(workQueue?.processing?.processedLastMinute).toBe(0);
  controller.abort();
  await cancelled;
  diagnostics.sample();
  expect(diagnostics.history()[0].timingsByTool).toMatchObject({
    'wm-document-query': { finished: 1, executed: 0, runMs: 0 },
  });
});

it('retains transient depths and dispatch waits between samples, includes active waiters, and does not replay waits at completion', async () => {
  vi.useFakeTimers();
  const db = new DatabaseSync(':memory:');
  let blocked = false;
  const exporter = observer(db);
  const queue = new ToolQueue(db, () => blocked, Date.now, exporter);
  const diagnostics = new HttpDiagnostics(db, '1.4.1', Date.now, queue, exporter);
  cleanup.push(() => db.close(), () => diagnostics.close(), () => queue.close());
  const metadata = () => ({ requestId: randomUUID(), operation: 'wm-ping', caller: 'owner' });
  await queue.run(metadata(), {}, new AbortController().signal, async () => {});
  expect(queue.state()).toMatchObject({ waiting: 0, peakQueueDepth: 0 });
  diagnostics.sample();
  expect(diagnostics.history()[0]).toMatchObject({ queueDepth: 0, peakQueueDepth: 0, maxQueueWaitMs: 0 });
  expect(queue.state().peakQueueDepth).toBe(0);
  blocked = true;
  let finish: () => void = () => {};
  const work = new Promise<void>(resolve => { finish = resolve; });
  const pending = queue.run(metadata(), {}, new AbortController().signal, () => work);
  await vi.advanceTimersByTimeAsync(750);
  expect(queue.state()).toMatchObject({ waiting: 1, peakQueueDepth: 1, maxQueueWaitMs: 750 });
  vi.spyOn(exporter, 'runtime').mockImplementationOnce(() => { throw new Error('sample rejected'); });
  expect(() => diagnostics.sample()).toThrow('sample rejected');
  expect(queue.state()).toMatchObject({ peakQueueDepth: 1, maxQueueWaitMs: 750 });
  diagnostics.sample();
  expect(diagnostics.history()[0]).toMatchObject({ queueDepth: 1, peakQueueDepth: 1, maxQueueWaitMs: 750 });
  blocked = false;
  await vi.advanceTimersByTimeAsync(250);
  expect(queue.state()).toMatchObject({ waiting: 0, running: 1, peakQueueDepth: 1, maxQueueWaitMs: 800 });
  diagnostics.sample();
  expect(diagnostics.history()[0]).toMatchObject({ queueDepth: 0, peakQueueDepth: 1, maxQueueWaitMs: 800 });
  expect(queue.state()).toMatchObject({ peakQueueDepth: 0, maxQueueWaitMs: 0 });
  finish();
  await pending;
  diagnostics.sample();
  expect(diagnostics.history()[0]).toMatchObject({ queueDepth: 0, peakQueueDepth: 0, maxQueueWaitMs: 0 });
});

it('bounds enabled runtime history in memory and never carries it across backend restarts', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-04T18:00:00Z'));
  const db = new DatabaseSync(':memory:');
  const diagnostics = new HttpDiagnostics(db, '1.4.1', Date.now, undefined, observer(db));
  cleanup.push(() => db.close());
  for (let i = 0; i < 185; i++) diagnostics.sample();
  expect(diagnostics.history(1000)).toHaveLength(180);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='instance_runtime_samples'").all()).toEqual([]);
  expect(diagnostics.history()).toHaveLength(60);
  diagnostics.close();
  const restarted = new HttpDiagnostics(db, '1.4.1', Date.now, undefined, observer(db));
  cleanup.push(() => restarted.close());
  expect(restarted.history()).toHaveLength(1);
  expect(restarted.history()[0].bootId).toBe(restarted.bootId);
  expect(restarted.history().some(sample => sample.bootId === diagnostics.bootId)).toBe(false);
});

it.each([
  { method: 'GET', path: '/changes?since=1', duration: DOCUMENT_CHANGE_POLL_TIMEOUT_MS, status: 200, contentType: 'application/json', code: null },
  { method: 'GET', path: '/changes', duration: DOCUMENT_CHANGE_POLL_TIMEOUT_MS + 2999, status: 200, contentType: 'application/json', code: null },
  { method: 'GET', path: '/changes', duration: DOCUMENT_CHANGE_POLL_TIMEOUT_MS + 3000, status: 200, contentType: 'application/json', code: 'slow_request' },
  { method: 'GET', path: '/changes', duration: 25000, status: 503, contentType: 'application/json', code: 'http_error' },
  { method: 'GET', path: '/changes', duration: 23000, status: 499, contentType: 'application/json', code: 'http_error' },
  { method: 'POST', path: '/changes', duration: 3000, status: 200, contentType: 'application/json', code: 'slow_request' },
  { method: 'GET', path: '/mcp', duration: 60000, status: 200, contentType: 'text/event-stream; charset=utf-8', code: null },
  { method: 'GET', path: '/mcp', duration: 60000, status: 503, contentType: 'text/event-stream', code: 'http_error' },
  { method: 'GET', path: '/mcp', duration: 3000, status: 200, contentType: 'application/json', code: 'slow_request' },
  { method: 'POST', path: '/mcp', duration: 3000, status: 200, contentType: 'text/event-stream', code: 'slow_request' },
  { method: 'GET', path: '/health', duration: 2999, status: 200, contentType: 'application/json', code: null },
  { method: 'GET', path: '/health', duration: 3000, status: 200, contentType: 'application/json', code: 'slow_request' },
])('classifies $method $path after $duration ms with HTTP $status as $code', async ({ method, path, duration, status, contentType, code }) => {
  const db = new DatabaseSync(':memory:');
  let now = 1793733600000;
  const diagnostics = new HttpDiagnostics(db, '1.4.1', () => now, undefined, observer(db, () => now));
  const server = createServer((req, res) => {
    diagnostics.track(req, res, () => 'owner');
    now += duration;
    res.writeHead(status, { 'content-type': contentType });
    res.end('done');
  });
  cleanup.push(() => db.close(), () => diagnostics.close(),
    () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
  await (await fetch(`http://127.0.0.1:${address.port}${path}`, { method })).text();
  const snapshot = diagnostics.snapshot(0);
  expect(snapshot.events.map(event => event.code)).toEqual(code ? [code] : []);
  expect(snapshot.minutes).toMatchObject([{ transactions: 1, maxMs: duration }]);
  expect(snapshot.runtime.activeRequests).toBe(0);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='instance_http_minutes'").all()).toEqual([]);
});

it('records top-level HTTP transactions and correlations without credentials, bodies or arbitrary URLs', async () => {
  const store = openStore(':memory:');
  new InstanceFeatureStore(store.db).write({ observability: true });
  const identity = new InstanceIdentity(store.db);
  const owner = await identity.initialize('a private monitoring test password');
  const access = new InstanceAccess(store.db, identity);
  const enrollment = access.request({ label: 'Untrusted caller label secret', access: 'read', refresh: false }, '', 'test');
  access.decide(owner.token, enrollment.requestId, true);
  const issued = access.claim(enrollment.requestId, enrollment.requestSecret);
  if (!('token' in issued)) throw new Error('Expected credential.');
  const server = await startServer({ port: 0, store });
  cleanup.push(() => store.close(), () => server.close());
  const request = (path: string, token = '', init: RequestInit = {}) => fetch(`${server.url}${path}`, {
    ...init, headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const health = await (await request('/health')).json();
  expect(health).toMatchObject({ ok: true, version: SERVICE_VERSION });
  expect(health.bootId).toMatch(/^[0-9a-f-]{36}$/);
  expect((await request('/identity/v1/diagnostics')).status).toBe(401);
  expect((await request('/identity/v1/diagnostics', issued.token)).status).toBe(401);
  expect((await request('/identity/v1/diagnostics', owner.token, { headers: { origin: 'http://untrusted.invalid' } })).status).toBe(400);
  expect((await request('/identity/v1/diagnostics?token=QUERY_SECRET', owner.token)).status).toBe(400);
  expect((await request('/identity/v1/diagnostics', owner.token, { method: 'POST' })).status).toBe(405);
  const response = await request('/PRIVATE_PATH?password=QUERY_SECRET', issued.token, {
    method: 'POST', body: 'PRIVATE_BODY',
  });
  expect(response.status).toBe(404);
  const requestId = response.headers.get('x-request-id');
  expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
  const snapshot = diagnosticsSchema.parse(await (await request('/identity/v1/diagnostics', owner.token)).json());
  expect(snapshot.events).toEqual(expect.arrayContaining([expect.objectContaining({
    code: 'http_error', route: '/other', status: 404, requestId,
  })]));
  expect(snapshot.callers).toEqual(expect.arrayContaining([expect.objectContaining({
    caller: 'client', route: '/other', status: 404, transactions: 1,
  })]));
  expect(snapshot.minutes.reduce((sum, minute) => sum + minute.transactions, 0)).toBeGreaterThanOrEqual(7);
  expect(snapshot.runtime.activeRequests).toBe(1);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [owner.token, issued.token, 'PRIVATE_PATH', 'QUERY_SECRET', 'PRIVATE_BODY', 'Untrusted caller label secret']) {
    expect(serialized).not.toContain(secret);
  }
});

it('normalizes routes, bounds enabled events in memory and retains only the operational clean-shutdown marker', () => {
  expect(diagnosticRoute('/attachments/private-id?token=secret')).toBe('/attachments/:id');
  expect(diagnosticRoute('/identity/v1/login?password=secret')).toBe('/identity/v1/*');
  const db = new DatabaseSync(':memory:');
  let now = 1793733600000;
  const diagnostics = new HttpDiagnostics(db, '1.4.1', () => now, undefined, observer(db, () => now));
  cleanup.push(() => db.close());
  diagnostics.event('http_error', 'request-one', '/mcp', 503, 3200);
  diagnostics.event('http_error', 'request-two', '/mcp', 503, 4000);
  expect(diagnostics.snapshot(0).events[0]).toMatchObject({ count: 1, requestId: 'request-two', durationMs: 4000 });
  for (let i = 0; i < 1100; i++) diagnostics.event('bounded_test');
  expect(diagnostics.snapshot(0).events).toHaveLength(100);
  diagnostics.close();
  const second = new HttpDiagnostics(db, '1.4.1', () => now, undefined, observer(db, () => now));
  expect(second.snapshot(0).events.some(event => event.code === 'unclean_restart')).toBe(false);
  expect(second.bootId).not.toBe(diagnostics.bootId);
  second.close();
  db.prepare('UPDATE instance_diagnostic_run SET clean=0').run();
  const third = new HttpDiagnostics(db, '1.4.1', () => now, undefined, observer(db, () => now));
  expect(third.snapshot(0).events.some(event => event.code === 'unclean_restart')).toBe(true);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='instance_diagnostic_events'").all()).toEqual([]);
  third.close();
  now += 8 * 86400000;
  const fourth = new HttpDiagnostics(db, '1.4.1', () => now, undefined, observer(db, () => now));
  expect(fourth.snapshot(0).events).toHaveLength(0);
  fourth.close();
});

it('retains the authenticated caller when logout revokes the token before the response finishes', async () => {
  const store = openStore(':memory:');
  new InstanceFeatureStore(store.db).write({ observability: true });
  const identity = new InstanceIdentity(store.db);
  const owner = await identity.initialize('private logout diagnostics password');
  const server = await startServer({ port: 0, store });
  cleanup.push(() => store.close(), () => server.close());
  const response = await fetch(`${server.url}/identity/v1/logout`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  expect(response.status).toBe(200);
  await response.body?.cancel();
  expect(identity.authenticate(owner.token)).toBe(false);
  const refreshed = await identity.login({ password: 'private logout diagnostics password' });
  const snapshot = diagnosticsSchema.parse(await (await fetch(`${server.url}/identity/v1/diagnostics`, {
    headers: { Authorization: `Bearer ${refreshed.token}` },
  })).json());
  expect(snapshot.callers).toEqual(expect.arrayContaining([
    expect.objectContaining({ caller: 'owner', route: '/identity/v1/*', status: 200 }),
  ]));
});

it('collects no disabled analytics while keeping health and live queue state', async () => {
  const observe = vi.spyOn(PerformanceObserver.prototype, 'observe');
  const db = new DatabaseSync(':memory:'), flags = { enabled: false };
  const exporter = new Observability(db, () => flags.enabled);
  const queue = new ToolQueue(db, () => true, Date.now, exporter);
  const diagnostics = new HttpDiagnostics(db, 'test', Date.now, queue, exporter);
  cleanup.push(() => db.close(), () => exporter.close(), () => diagnostics.close(), () => queue.close());
  const controller = new AbortController();
  const pending = queue.run({ requestId: randomUUID(), operation: 'wm-ping', caller: 'owner' }, {},
    controller.signal, async () => {});
  const cancelled = expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  db.exec('PRAGMA query_only=ON');
  diagnostics.sample();
  diagnostics.event('ignored');
  expect(observe).not.toHaveBeenCalled();
  const snapshot = diagnosticsSchema.parse(diagnostics.snapshot(1));
  expect(snapshot).toMatchObject({ minutes: [], callers: [], events: [], samples: [], workQueue: { waiting: 1 } });
  expect(snapshot.runtime.heapUsedBytes).toBeGreaterThan(0);
  controller.abort();
  await cancelled;
  flags.enabled = true;
  diagnostics.syncEnabled();
  expect(observe).toHaveBeenCalledTimes(1);
  expect(diagnostics.history()).toHaveLength(1);
  flags.enabled = false;
  exporter.syncEnabled();
  diagnostics.syncEnabled();
  diagnostics.sample();
  expect(diagnostics.history()).toEqual([]);
  expect(exporter.history(100)).toEqual([]);
  db.exec('PRAGMA query_only=OFF');
});

it('keeps request correlation while disabled and does not retroactively observe a request when enabled before its response', async () => {
  const db = new DatabaseSync(':memory:'), flags = { enabled: false };
  const exporter = new Observability(db, () => flags.enabled);
  const diagnostics = new HttpDiagnostics(db, 'test', Date.now, undefined, exporter);
  const caller = vi.fn(() => 'owner');
  const server = createServer((req, res) => {
    diagnostics.track(req, res, caller);
    flags.enabled = true;
    diagnostics.syncEnabled();
    res.end('done');
  });
  cleanup.push(() => db.close(), () => exporter.close(), () => diagnostics.close(),
    () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
  const response = await fetch(`http://127.0.0.1:${address.port}/mcp`);
  await response.text();
  expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  expect(caller).not.toHaveBeenCalled();
  expect(diagnostics.snapshot(0)).toMatchObject({ minutes: [], callers: [], events: [], runtime: { activeRequests: 0 } });
  await (await fetch(`http://127.0.0.1:${address.port}/mcp`)).text();
  expect(caller).toHaveBeenCalledTimes(1);
  expect(diagnostics.snapshot(0).minutes).toMatchObject([{ transactions: 1 }]);
  flags.enabled = false;
  exporter.syncEnabled();
});

it('invalidates a pending HTTP observation across a disable/re-enable collection boundary', async () => {
  const db = new DatabaseSync(':memory:'), flags = { enabled: true };
  let now = Date.now(), release = () => {}, arrived = () => {};
  const received = new Promise<void>(resolve => { arrived = resolve; });
  const exporter = new Observability(db, () => flags.enabled, { clock: () => now });
  const diagnostics = new HttpDiagnostics(db, 'test', () => now, undefined, exporter);
  const caller = vi.fn(() => 'owner');
  const server = createServer((req, res) => {
    diagnostics.track(req, res, caller);
    if (req.url === '/fresh') { now += 10; res.end('fresh'); }
    else { release = () => res.end('old'); arrived(); }
  });
  cleanup.push(() => db.close(), () => exporter.close(), () => diagnostics.close(),
    () => new Promise<void>((resolve, reject) => { release(); server.close(error => error ? reject(error) : resolve()); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port.');
  const url = `http://127.0.0.1:${address.port}`;
  const pending = fetch(`${url}/changes`);
  await received;
  expect(diagnostics.snapshot(0).runtime.activeRequests).toBe(1);
  now += 1000;
  flags.enabled = false;
  exporter.syncEnabled(); diagnostics.syncEnabled();
  now += 60000;
  flags.enabled = true;
  exporter.syncEnabled(); diagnostics.syncEnabled();
  release();
  const response = await pending;
  await response.text();
  expect(response.headers.get('X-Request-Id')).toMatch(/^[0-9a-f-]{36}$/);
  expect(diagnostics.snapshot(0)).toMatchObject({ minutes: [], callers: [], events: [], runtime: { activeRequests: 0 } });
  await (await fetch(`${url}/fresh`)).text();
  expect(diagnostics.snapshot(0).minutes).toMatchObject([{ transactions: 1, maxMs: 10 }]);
  expect(caller).toHaveBeenCalledTimes(2);
  flags.enabled = false;
  exporter.syncEnabled();
});
