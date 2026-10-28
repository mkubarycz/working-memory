import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { InstanceFeatureStore } from '../src/instanceFeatures';
import { InstanceIdentity } from '../src/instanceIdentity';
import { HostTaskBroker } from '../src/hostTasks';
import { openStore, type Store } from '../src/store';
import { startServer, type RunningServer } from '../src/server';

const stores: Store[] = [], servers: RunningServer[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  stores.splice(0).forEach(store => store.close());
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it('defaults off and persists each instance choice across database reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wm-features-'));
  directories.push(directory);
  const filename = join(directory, 'journal.sqlite');
  const first = openStore(filename);
  const flags = new InstanceFeatureStore(first.db);
  expect(flags.read()).toEqual({ hostTasks: false });
  flags.write({ hostTasks: true });
  first.close();
  const reopened = openStore(filename);
  stores.push(reopened);
  expect(new InstanceFeatureStore(reopened.db).read()).toEqual({ hostTasks: true });
  new InstanceFeatureStore(reopened.db).write({ hostTasks: false });
  expect(() => new HostTaskBroker(reopened.db).dispatch('GET', '/admin', '')).toThrow('host_tasks_feature_disabled');
  const another = openStore(':memory:');
  stores.push(another);
  expect(new InstanceFeatureStore(another.db).read()).toEqual({ hostTasks: false });
});

it('blocks all host-task HTTP/MCP usage while off, preserves records, and requires owner auth to toggle', async () => {
  const store = openStore(':memory:');
  stores.push(store);
  const owner = await new InstanceIdentity(store.db).initialize('private feature owner password');
  const bootstrap = randomBytes(32).toString('hex');
  const server = await startServer({ port: 0, store, hostTaskAdminCredential: bootstrap });
  servers.push(server);
  const request = (path: string, method = 'GET', body?: unknown, token?: string, origin?: string) => fetch(server.url + path, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(origin ? { Origin: origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  expect((await request('/features/v1')).status).toBe(401);
  expect(await (await request('/features/v1', 'GET', undefined, owner.token)).json()).toEqual({ hostTasks: false });
  for (const [method, path] of [
    ['GET', '/admin'], ['GET', '/admin/scripts'], ['POST', '/admin/apps'], ['POST', '/requests'],
    ['POST', '/runner/claim'], ['POST', '/scripts/mcp'], ['POST', '/admin/scripts/claim'],
    ['GET', '/scripts/jobs/any-id'], ['POST', '/admin/scripts/complete'],
    ['POST', '/admin/scripts'], ['POST', '/admin/scripts/test/claim'],
    ['GET', '/admin/scripts/00000000-0000-4000-8000-000000000001'],
    ['POST', '/admin/scripts/00000000-0000-4000-8000-000000000001/versions'],
    ['POST', '/admin/scripts/00000000-0000-4000-8000-000000000001/publish'],
  ]) {
    const response = await request(`/host-tasks/v1${path}`, method, undefined, owner.token);
    expect(response.status, path).toBe(503);
    expect(await response.json()).toEqual({
      error: 'feature_disabled', feature: 'hostTasks',
      message: 'Host tasks is turned off. Enable it in Settings > Features.',
    });
  }
  expect((await request('/features/v1', 'POST', { hostTasks: true })).status).toBe(401);
  expect((await request('/features/v1', 'POST', { hostTasks: true }, bootstrap)).status).toBe(401);
  expect((await request('/features/v1', 'POST', { hostTasks: true }, owner.token, 'https://example.com')).status).toBe(400);
  expect((await request('/features/v1?hostTasks=true')).status).toBe(400);
  expect((await request('/features/v1', 'POST', { hostTasks: 'true' }, owner.token)).status).toBe(400);
  expect((await request('/features/v1', 'POST', { hostTasks: true, unknown: true }, owner.token)).status).toBe(400);
  expect((await request('/features/v1', 'POST', { hostTasks: true }, owner.token)).status).toBe(200);
  expect((await request('/host-tasks/v1/admin/scripts')).status).toBe(401);
  const created = await request('/host-tasks/v1/admin/scripts', 'POST', {
    name: 'Retained script', description: '', hostId: randomUUID(), source: 'module.exports = () => ({});',
    parameters: {}, timeoutMs: 1000,
  }, owner.token);
  expect(created.status).toBe(201);
  const task = await created.json() as { id: string };
  expect((await request('/features/v1', 'POST', { hostTasks: false }, owner.token)).status).toBe(200);
  expect((await request('/host-tasks/v1/admin/scripts', 'GET', undefined, owner.token)).status).toBe(503);
  expect((await request('/identity/v1/status')).status).toBe(200);
  expect((await request('/features/v1', 'POST', { hostTasks: true }, owner.token)).status).toBe(200);
  const snapshot = await (await request('/host-tasks/v1/admin/scripts', 'GET', undefined, owner.token)).json();
  expect(snapshot).toMatchObject({ tasks: [{ id: task.id }] });
  await request('/identity/v1/logout', 'POST', {}, owner.token);
  expect((await request('/features/v1', 'POST', { hostTasks: false }, owner.token)).status).toBe(401);
});
