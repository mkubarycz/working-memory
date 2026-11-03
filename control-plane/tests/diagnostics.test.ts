import { afterEach, beforeAll, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { InstanceIdentity } from '../src/instanceIdentity';
import { InstanceAccess } from '../src/instanceAccess';
import { startServer } from '../src/server';
import { diagnosticsSchema } from '../src/diagnosticContract';
import { diagnosticRoute, HttpDiagnostics } from '../src/diagnostics';
import { openStore } from '../src/store';
import { loadKinds } from '../src/kinds/loader';
import { SERVICE_VERSION } from '../src/config';

const cleanup: Array<() => Promise<void> | void> = [];
beforeAll(() => loadKinds());
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

it('records top-level HTTP transactions and correlations without credentials, bodies or arbitrary URLs', async () => {
  const store = openStore(':memory:');
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
    caller: `client:${access.authenticate(issued.token)!.clientId}`, route: '/other', status: 404, transactions: 1,
  })]));
  expect(snapshot.minutes.reduce((sum, minute) => sum + minute.transactions, 0)).toBeGreaterThanOrEqual(7);
  expect(snapshot.runtime.activeRequests).toBe(1);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [owner.token, issued.token, 'PRIVATE_PATH', 'QUERY_SECRET', 'PRIVATE_BODY', 'Untrusted caller label secret']) {
    expect(serialized).not.toContain(secret);
  }
});

it('normalizes user-controlled routes and distinguishes clean from unclean restarts with bounded persistence', () => {
  expect(diagnosticRoute('/attachments/private-id?token=secret')).toBe('/attachments/:id');
  expect(diagnosticRoute('/identity/v1/login?password=secret')).toBe('/identity/v1/*');
  const db = new DatabaseSync(':memory:');
  let now = 1793733600000;
  const diagnostics = new HttpDiagnostics(db, '1.4.1', () => now);
  cleanup.push(() => db.close());
  diagnostics.event('http_error', 'request-one', '/mcp', 503, 3200, true);
  diagnostics.event('http_error', 'request-two', '/mcp', 503, 4000, true);
  expect(diagnostics.snapshot(0).events[0]).toMatchObject({ count: 2, requestId: 'request-two', durationMs: 4000 });
  for (let i = 0; i < 1100; i++) diagnostics.event('bounded_test');
  expect(db.prepare('SELECT COUNT(*) AS count FROM instance_diagnostic_events').get()?.count).toBe(1000);
  diagnostics.close();
  const second = new HttpDiagnostics(db, '1.4.1', () => now);
  expect(second.snapshot(0).events.some(event => event.code === 'unclean_restart')).toBe(false);
  expect(second.bootId).not.toBe(diagnostics.bootId);
  second.close();
  db.prepare('UPDATE instance_diagnostic_run SET clean=0').run();
  for (let i = 0; i < 1100; i++) {
    db.prepare(`INSERT INTO instance_diagnostic_events
      (at,code,request_id,route,status,duration_ms,count,bucket) VALUES(?,'test',NULL,'/runtime',0,0,1,NULL)`).run(now);
  }
  const third = new HttpDiagnostics(db, '1.4.1', () => now);
  expect(third.snapshot(0).events.some(event => event.code === 'unclean_restart')).toBe(true);
  expect(db.prepare('SELECT COUNT(*) AS count FROM instance_diagnostic_events').get()?.count).toBe(1000);
  third.close();
  now += 8 * 86400000;
  const fourth = new HttpDiagnostics(db, '1.4.1', () => now);
  expect(fourth.snapshot(0).events).toHaveLength(0);
  fourth.close();
});
