import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startServer, type RunningServer } from '../control-plane/src/server';
import { openStore, type Store } from '../control-plane/src/store';
import { HostTaskBroker, HOST_TASK_CLEANUP_INTERVAL_MS, HOST_TASK_OPERATION, HOST_TASK_OPERATION_HASH } from '../control-plane/src/hostTasks';
import { InstanceFeatureStore } from '../control-plane/src/instanceFeatures';

const servers: RunningServer[] = [];
const stores: Store[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => s.close()));
  stores.splice(0).forEach(s => s.close());
  dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
  vi.restoreAllMocks();
  vi.useRealTimers();
});
const admin = randomBytes(32).toString('hex');
const approvalBinding = { policyHash: HOST_TASK_OPERATION_HASH, operationVersion: HOST_TASK_OPERATION.version };
async function fixture(enabled = true, store?: Store) {
  if (!store) { store = openStore(':memory:'); stores.push(store); }
  new InstanceFeatureStore(store.db).write({ hostTasks: true });
  const server = await startServer({ port: 0, store, hostTaskAdminCredential: enabled ? admin : undefined });
  servers.push(server);
  const call = async (route: string, method = 'GET', body?: unknown, credential = admin) => {
    const response = await fetch(`${server.url}/host-tasks/v1${route}`, {
      method, headers: { authorization: ['Bearer', credential].join(' '), 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  };
  return { server, call };
}
describe('protected host-task HTTP surface', () => {
  it('runs periodic trusted maintenance and stops its interval on server close without timer sleeps', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const cleanup = vi.spyOn(HostTaskBroker.prototype, 'cleanup');
    const f = await fixture();
    expect(cleanup).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(HOST_TASK_CLEANUP_INTERVAL_MS);
    expect(cleanup).toHaveBeenCalledTimes(2);
    servers.splice(servers.indexOf(f.server), 1);
    await f.server.close();
    vi.advanceTimersByTime(HOST_TASK_CLEANUP_INTERVAL_MS * 3);
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it('durably returns 202 awaiting-approval before a grant and rejects self-approved authority', async () => {
    const dir = fs.mkdtempSync(path.resolve('.host-task-http-tests-'));
    dirs.push(dir);
    const filename = path.join(dir, 'broker.sqlite');
    const firstStore = openStore(filename); stores.push(firstStore);
    const first = await fixture(true, firstStore);
    const app = (await first.call('/admin/apps', 'POST', { label: 'App', instanceId: 'awaiting-app' })).body;
    const request = { capability: 'thrive.sync.read', idempotencyKey: 'awaiting-key' };
    const pending = await first.call('/requests', 'POST', request, app.credential);
    expect(pending.status).toBe(202);
    expect(pending.body.state).toBe('awaiting-approval');
    expect(pending.body.grantId).toBeNull();
    const approval = {
      ...approvalBinding,
      appId: app.appId, windowsSid: 'S-1-5-21-123-456-789-1001',
      tenantId: '12345678-1234-4234-8234-123456789012', expiresAt: Date.now() + 3600000,
    };
    expect((await first.call('/admin/grants', 'POST', approval, app.credential)).status).toBe(401);
    expect((await first.call('/requests', 'POST', { ...request, approved: true, grantId: randomUUID() }, app.credential)).status).toBe(400);
    firstStore.createDocument({ kind: 'Config', spec: { approved: true, ...approval } });
    expect((await first.call(`/jobs/${pending.body.id}`, 'GET', undefined, app.credential)).body.state).toBe('awaiting-approval');
    servers.splice(servers.indexOf(first.server), 1);
    await first.server.close();
    stores.splice(stores.indexOf(firstStore), 1); firstStore.close();
    const reopened = openStore(filename); stores.push(reopened);
    const second = await fixture(true, reopened);
    const replay = await second.call('/requests', 'POST', request, app.credential);
    expect(replay.status).toBe(202);
    expect(replay.body.id).toBe(pending.body.id);
    expect(replay.body.state).toBe('awaiting-approval');
    expect((await second.call('/admin', 'GET')).body.grants).toEqual([]);
    expect((await second.call('/admin/grants', 'POST', approval)).status).toBe(201);
    expect((await second.call(`/jobs/${pending.body.id}`, 'GET', undefined, app.credential)).body.state).toBe('queued');
  });
  it('does not disclose or mutate another app job through status, results, ack, or cancel routes', async () => {
    const f = await fixture();
    const a = (await f.call('/admin/apps', 'POST', { label: 'A', instanceId: 'a' })).body;
    const b = (await f.call('/admin/apps', 'POST', { label: 'B', instanceId: 'b' })).body;
    const job = (await f.call('/requests', 'POST', {
      capability: 'thrive.sync.read', idempotencyKey: 'same-key',
    }, a.credential)).body;
    for (const [suffix, method, body] of [
      ['', 'GET', undefined], ['/results', 'GET', undefined],
      ['/ack', 'POST', {}], ['/cancel', 'POST', {}],
    ] as const) {
      const response = await f.call(`/jobs/${job.id}${suffix}`, method, body, b.credential);
      expect(response).toEqual({ status: 404, body: { error: 'job_not_found' } });
    }
    expect((await f.call(`/jobs/${job.id}`, 'GET', undefined, a.credential)).body.state).toBe('awaiting-approval');
    const independent = await f.call('/requests', 'POST', {
      capability: 'thrive.sync.read', idempotencyKey: 'same-key',
    }, b.credential);
    expect(independent.status).toBe(202);
    expect(independent.body.id).not.toBe(job.id);
  });
  it('provides no public bootstrap or admin when unconfigured', async () => {
    const f = await fixture(false);
    expect(await f.call('/admin')).toEqual({ status: 503, body: { error: 'admin_disabled' } });
    expect((await f.call('/admin/bootstrap', 'POST', {})).status).toBe(503);
    expect((await f.call('/requests', 'POST', {})).status).toBe(401);
  });
  it('exposes only strict own routes and returns 202 without pretending execution succeeded', async () => {
    const f = await fixture();
    const provision = await f.call('/admin/apps', 'POST', { label: 'Desktop', instanceId: 'one' });
    expect(provision.status).toBe(201);
    const { appId, credential } = provision.body;
    const grant = await f.call('/admin/grants', 'POST', {
      ...approvalBinding,
      appId, windowsSid: 'S-1-5-21-123-456-789-1001',
      tenantId: '12345678-1234-4234-8234-123456789012', expiresAt: Date.now() + 3600000,
    });
    expect(grant.status).toBe(201);
    const queued = await f.call('/requests', 'POST', { capability: 'thrive.sync.read', idempotencyKey: 'test' }, credential);
    expect(queued.status).toBe(202);
    expect(queued.body.state).toBe('queued');
    expect(queued.body.blockedReason).toContain('verified Windows');
    expect((await f.call(`/jobs/${queued.body.id}`, 'GET', undefined, credential)).status).toBe(200);
    expect((await f.call(`/jobs/${queued.body.id}/results`, 'GET', undefined, credential)).status).toBe(409);
    expect((await f.call('/admin', 'GET', undefined, credential)).status).toBe(401);
    expect((await f.call('/jobs', 'GET', undefined, credential)).status).toBe(404);
    expect((await f.call(`/jobs/${queued.body.id}/cancel`, 'POST', {}, credential)).status).toBe(200);
    const snapshot = await f.call('/admin');
    expect(snapshot.body.executionBlockedReason).toContain('Agency');
    expect(JSON.stringify(snapshot.body)).not.toContain(credential);
    expect(JSON.stringify(snapshot.body)).not.toContain(admin);
    for (const route of ['/mcp', '/health', '/attachments']) {
      const response = await fetch(`${f.server.url}${route}`, { headers: { authorization: ['Bearer', credential].join(' ') } });
      expect(response.status).toBe(403);
    }
  });
  it('rejects unknown fields on all protected admin mutations', async () => {
    const f = await fixture();
    expect((await f.call('/admin/apps', 'POST', { label: 'Desktop', instanceId: 'one', admin: true })).status).toBe(400);
    expect((await f.call('/admin/grants', 'POST', { appId: 'fake', windowsSid: 'S-1-5-1', tenantId: 'fake', expiresAt: 1, scope: '*' })).status).toBe(400);
    expect((await f.call('/admin/runners', 'POST', { windowsSid: 'S-1-5-1', tenantId: 'fake', verified: true })).status).toBe(400);
  });
  it('rejects query overrides, invalid JSON, wrong content type and oversized bodies', async () => {
    const f = await fixture();
    expect((await f.call('/admin?token=anything')).status).toBe(400);
    for (const [contentType, body, status] of [
      ['application/json', '{bad', 400],
      ['text/plain', '{}', 415],
      ['application/json', JSON.stringify({ label: 'x'.repeat(131073) }), 413],
    ] as const) {
      const response = await fetch(`${f.server.url}/host-tasks/v1/admin/apps`, {
        method: 'POST', headers: { authorization: ['Bearer', admin].join(' '), 'content-type': contentType }, body,
      });
      expect(response.status).toBe(status);
      expect(await response.text()).not.toContain(body);
    }
  });
});
