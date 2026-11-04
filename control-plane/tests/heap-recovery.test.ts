import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { startServer } from '../src/server';
import { openStore } from '../src/store';
import { loadKinds } from '../src/kinds/loader';
import { defaultStatus, validateSpec } from '../src/kinds/registry';
import { InstanceIdentity } from '../src/instanceIdentity';
import { InstanceAccess } from '../src/instanceAccess';
import { McpSessions } from '../src/mcpSessions';

const cleanup: Array<() => Promise<void> | void> = [];
beforeAll(() => loadKinds());
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const store = openStore(':memory:');
  const owner = await new InstanceIdentity(store.db).initialize('private heap recovery test password');
  const identity = new InstanceIdentity(store.db);
  const access = new InstanceAccess(store.db, identity);
  const enrollment = access.request({ label: 'Test client', access: 'write', refresh: false }, '', 'test');
  access.decide(owner.token, enrollment.requestId, true);
  const issued = access.claim(enrollment.requestId, enrollment.requestSecret);
  if (!('token' in issued)) throw new Error('Expected approved credential.');
  let used = 600;
  const collect = vi.fn(() => { used = 100; });
  const server = await startServer({ port: 0, store, sessionDiagnostics: { memory: () => ({ used, limit: 1000 }), collectGarbage: collect } });
  cleanup.push(() => store.close(), () => server.close());
  store.createDocument({ kind: 'TopicType', spec: validateSpec('TopicType', { label: 'Bug', icon: 'bug', description: 'Synthetic test' }),
    status: defaultStatus('TopicType') });
  const request = (path: string, body?: object, token = owner.token, headers: Record<string, string> = {}) =>
    fetch(`${server.url}${path}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  const snapshot = await (await request('/identity/v1/sessions')).json();
  const report = { incidentId: randomUUID(), expectedStartedAt: snapshot.startedAt, confirmed: true };
  return { store, server, owner, issued, request, snapshot, report, collect };
}

it('saves an idempotent Inbox report without new MCP admission, then collects garbage with a persisted audit', async () => {
  const f = await fixture();
  const admission = await f.request('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'heap-test', version: '1' } } });
  expect(admission.status).toBe(503);
  expect(f.snapshot.memory).toMatchObject({ admissionBlocked: true, gcAvailable: true });
  const saved = await f.request('/identity/v1/sessions/report', f.report);
  expect(saved.status).toBe(200);
  const { topicId } = await saved.json();
  expect(await (await f.request('/identity/v1/sessions/report', f.report)).json()).toEqual({ topicId });
  expect(f.store.listDocuments({ kind: 'Topic' })).toHaveLength(1);
  const topic = f.store.getDocument({ kind: 'Topic', id: topicId })!;
  expect(topic.metadata.labels['wm.incident']).toBe(f.report.incidentId);
  expect(topic.spec.body).not.toContain(f.owner.token);
  expect(f.collect).not.toHaveBeenCalled();
  const payload = { expectedStartedAt: f.snapshot.startedAt, reportTopicId: topicId, confirmed: true };
  const response = await f.request('/identity/v1/sessions/gc', payload);
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.collection).toMatchObject({ beforeBytes: 600, afterBytes: 100, reclaimedBytes: 500, idleSessionsReclaimed: 0 });
  expect(result.snapshot.memory.admissionBlocked).toBe(false);
  expect(result.snapshot.events.some((event: { type: string }) => event.type === 'garbage_collected')).toBe(true);
  expect(f.collect).toHaveBeenCalledTimes(1);
  const limited = await f.request('/identity/v1/sessions/gc', payload);
  expect(limited.status).toBe(429);
  expect(limited.headers.get('retry-after')).toBe('60');
  expect(f.collect).toHaveBeenCalledTimes(1);
});

it('delivers automatic incidents at the heap cutoff using only a label/ID lookup, not all topic bodies', async () => {
  const f = await fixture();
  const unrelated = f.store.createDocument({
    kind: 'Topic', spec: validateSpec('Topic', {
      title: 'Large unrelated document', body: 'private unrelated body '.repeat(10000),
      topicType: f.store.listDocuments({ kind: 'TopicType' })[0].metadata.id,
    }), status: defaultStatus('Topic'),
  });
  const list = vi.spyOn(f.store, 'listDocuments').mockImplementation(() => { throw new Error('Unbounded list'); });
  const get = vi.spyOn(f.store, 'getDocument');
  const incident = { id: randomUUID(), at: Date.now(), environment: `${f.server.url}/mcp`,
    kind: 'memory_pressure', evidence: 'Synthetic heap safety cutoff.' };
  const response = await f.request('/identity/v1/incidents', incident);
  expect(response.status).toBe(200);
  const { topicId } = await response.json();
  expect(await (await f.request('/identity/v1/incidents', incident)).json()).toEqual({ topicId });
  expect(list).not.toHaveBeenCalled();
  expect(get.mock.calls.some(([input]) => input.id === unrelated.metadata.id)).toBe(false);
  expect(f.collect).not.toHaveBeenCalled();
  expect((await f.request('/identity/v1/incidents', incident, f.issued.token)).status).toBe(401);
  expect((await f.request('/identity/v1/incidents', incident, f.owner.token, { Origin: 'https://untrusted.invalid' })).status).toBe(400);
  expect((await f.request('/identity/v1/incidents?extra=1', incident)).status).toBe(400);
  expect((await f.request('/identity/v1/incidents')).status).toBe(405);
  expect((await f.request('/identity/v1/incidents', { ...incident, evidence: 'x'.repeat(20001) })).status).toBe(400);
});

it('requires trusted owner confirmation, a saved report and the same server start time', async () => {
  const f = await fixture(), path = '/identity/v1/sessions/report';
  expect((await f.request(path, f.report, '')).status).toBe(401);
  expect((await f.request(path, f.report, f.issued.token)).status).toBe(401);
  expect((await f.request(path, f.report, f.owner.token, { Origin: 'http://untrusted.invalid' })).status).toBe(400);
  expect((await f.request(path + '?token=forbidden', f.report)).status).toBe(400);
  expect((await f.request(path, { ...f.report, confirmed: false })).status).toBe(400);
  expect((await f.request(path, { ...f.report, expectedStartedAt: f.snapshot.startedAt - 1 })).status).toBe(409);
  const missing = { confirmed: true, expectedStartedAt: f.snapshot.startedAt, reportTopicId: randomUUID() };
  expect((await f.request('/identity/v1/sessions/gc', missing)).status).toBe(400);
  expect(f.collect).not.toHaveBeenCalled();
  expect(f.store.listDocuments({ kind: 'Workstream' })).toHaveLength(0);
  const { topicId } = await (await f.request(path, f.report)).json();
  const payload = { confirmed: true, expectedStartedAt: f.snapshot.startedAt, reportTopicId: topicId };
  expect((await f.request('/identity/v1/sessions/gc', payload, f.issued.token)).status).toBe(401);
  expect((await f.request('/identity/v1/sessions/gc', { ...payload, confirmed: false })).status).toBe(400);
  expect((await f.request('/identity/v1/sessions/gc', { ...payload, expectedStartedAt: f.snapshot.startedAt - 1 })).status).toBe(409);
  expect(f.collect).not.toHaveBeenCalled();
});

it('never reopens a closed Inbox to save a report', async () => {
  const f = await fixture();
  f.store.createDocument({ kind: 'Workstream', spec: validateSpec('Workstream', { title: 'Inbox', status: 'closed', closure: 'Closed by user' }),
    status: defaultStatus('Workstream') });
  const result = await f.request('/identity/v1/sessions/report', f.report);
  expect(result.status).toBe(400);
  expect((await result.json()).error).toContain('Inbox is closed');
  expect(f.store.listDocuments({ kind: 'Topic' })).toHaveLength(0);
  expect(f.collect).not.toHaveBeenCalled();
});

it('reclaims only idle sessions and waits for an in-progress collector during shutdown', async () => {
  const store = openStore(':memory:');
  const owner = await new InstanceIdentity(store.db).initialize('private collector unit password');
  const principal = new InstanceAccess(store.db, new InstanceIdentity(store.db)).authenticate(owner.token)!;
  let now = Date.now(), release: (() => void) | undefined;
  const collect = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const sessions = new McpSessions(store.db, { clock: () => now, collectGarbage: collect });
  cleanup.push(() => store.close(), () => sessions.close());
  const idle = sessions.admit(principal, 'idle'), active = sessions.admit(principal, 'active');
  const closeIdle = vi.fn(async () => {});
  idle.close = closeIdle;
  active.activeRequests = 1;
  now += 61 * 60000;
  const snapshot = sessions.snapshot();
  const collecting = sessions.collectGarbage(snapshot.startedAt, randomUUID());
  await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
  expect(closeIdle).toHaveBeenCalledTimes(1);
  expect(sessions.activeCount).toBe(1);
  const closing = sessions.close();
  let closed = false;
  void closing.then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  release?.();
  expect((await collecting).idleSessionsReclaimed).toBe(1);
  await closing;
  expect(closed).toBe(true);
});
