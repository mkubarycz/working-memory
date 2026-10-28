import { afterEach, beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStore } from '../src/store';
import { startServer } from '../src/server';
import { InstanceIdentity } from '../src/instanceIdentity';
import { InstanceAccess } from '../src/instanceAccess';
import { loadKinds } from '../src/kinds/loader';
import { defaultInstancePermissions, type InstancePermissions } from '../src/instancePermissions';
import { authorizeInstanceTool } from '../src/instanceAuthorization';
import { HostTaskBroker } from '../src/hostTasks';
import { randomUUID } from 'node:crypto';
import { scriptTaskSchema, scriptJobSchema, scriptVersionSchema } from '../src/hostScriptPolicy';

const cleanup: Array<() => Promise<void>> = [];
const password = 'owner password for access tests';
beforeAll(async () => { await loadKinds(); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture(configured = true) {
  const store = openStore(':memory:');
  let now = Date.now();
  const identity = new InstanceIdentity(store.db, () => now);
  const owner = configured ? await identity.initialize(password, 'A literal <hint>') : null;
  const access = new InstanceAccess(store.db, identity, () => now);
  const server = await startServer({ port: 0, store, hostTaskClock: () => now });
  cleanup.push(async () => { await server.close(); store.close(); });
  const connect = async (token?: string, path = '/mcp') => {
    const client = new Client({ name: 'access-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL(path, server.url), {
      requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    });
    await client.connect(transport);
    cleanup.push(async () => { await client.close(); });
    return client;
  };
  return { store, identity, owner, access, server, connect, now: () => now, advance: (ms: number) => { now += ms; } };
}

function value(result: unknown): Record<string, unknown> {
  const parsed = result as { content: Array<{ text?: string }> };
  return JSON.parse(parsed.content.find(item => item.text)?.text ?? '{}');
}

const noPermissions = (): InstancePermissions => ({
  content: { create: false, read: false, update: false, delete: false },
  settings: { create: false, read: false, update: false, delete: false },
  tools: { create: false, read: false, update: false, delete: false, run: false },
});

it('queues only missing permissions on denial and approval updates the same client and live MCP session', async () => {
  const { access, owner, connect, store } = await fixture();
  store.createDocument({ kind: 'TopicType', spec: { label: 'Topic', icon: 'symbol-key' } });
  const enrollment = access.request({ label: 'VS Code Copilot', access: 'write', refresh: false }, '', 'test');
  const initial = noPermissions();
  initial.content.read = true;
  access.setPermissions(owner!.token, enrollment.requestId, 'request', initial);
  access.decide(owner!.token, enrollment.requestId, true);
  const issued = access.claim(enrollment.requestId, enrollment.requestSecret);
  if (!('token' in issued)) throw new Error('Expected client credential');
  const before = access.snapshot(owner!.token).clients[0];
  const client = await connect(issued.token);
  const create = () => client.callTool({ name: 'ws-topic-create', arguments: { title: 'Approved scoped request' } });
  await expect(create()).rejects.toThrow('Additional access requested');
  await expect(create()).rejects.toThrow('Additional access requested');
  let snapshot = access.snapshot(owner!.token);
  expect(snapshot.clients).toEqual([before]);
  expect(snapshot.requests).toHaveLength(1);
  const request = snapshot.requests[0];
  const expected = noPermissions();
  expected.content.create = true;
  expect(request).toMatchObject({ purpose: 'permissions', clientId: issued.clientId, permissions: expected, state: 'pending' });
  expect(() => access.decide(issued.token, String(request.id), true)).toThrow('owner');
  expect(() => access.claimApproved(String(request.id))).toThrow('cannot issue credentials');
  access.decide(owner!.token, String(request.id), true);
  snapshot = access.snapshot(owner!.token);
  expect(snapshot.requests).toEqual([]);
  expect(snapshot.clients).toHaveLength(1);
  expect(snapshot.clients[0]).toMatchObject({
    id: before.id, createdAt: before.createdAt, expiresAt: before.expiresAt,
    permissions: { ...initial, content: { ...initial.content, create: true } },
  });
  expect(access.authenticate(issued.token)?.clientId).toBe(issued.clientId);
  expect((await create()).isError).not.toBe(true);
});

it('deduplicates scoped requests and prevents expired, revoked or manually invalidated approvals', async () => {
  const { access, owner, advance } = await fixture();
  const enrollment = access.request({ label: 'Scoped reader', access: 'write', refresh: false }, '', 'test');
  access.setPermissions(owner!.token, enrollment.requestId, 'request', noPermissions());
  access.decide(owner!.token, enrollment.requestId, true);
  const issued = access.claim(enrollment.requestId, enrollment.requestSecret);
  if (!('token' in issued)) throw new Error('Expected client credential');
  const ask = () => access.requestPermissions(issued.token, [{ category: 'content', operation: 'create' }], 'test');
  const request = ask();
  if (request.state !== 'pending') throw new Error('Expected pending request');
  for (let repeat = 0; repeat < 20; repeat++) expect(ask()).toEqual(request);
  access.decide(owner!.token, request.requestId, false);
  expect(access.authenticate(issued.token)?.permissions.content.create).toBe(false);
  expect(ask()).toMatchObject({ state: 'denied', requestId: request.requestId });
  expect(access.snapshot(owner!.token).requests).toHaveLength(1);
  advance(10 * 60 * 1000);
  const manual = ask();
  if (manual.state !== 'pending') throw new Error('Expected pending request');
  access.setPermissions(owner!.token, issued.clientId, 'client', noPermissions());
  expect(() => access.decide(owner!.token, manual.requestId, true)).toThrow('already reviewed');
  advance(10 * 60 * 1000);
  const expired = ask();
  if (expired.state !== 'pending') throw new Error('Expected pending request');
  advance(10 * 60 * 1000);
  expect(() => access.decide(owner!.token, expired.requestId, true)).toThrow('expired');
  const revoked = ask();
  if (revoked.state !== 'pending') throw new Error('Expected pending request');
  access.revoke(owner!.token, issued.clientId);
  expect(() => access.decide(owner!.token, revoked.requestId, true)).toThrow('already reviewed');
  expect(ask).toThrow('active client credential');
  expect(() => access.requestPermissions('', [{ category: 'content', operation: 'create' }], 'test')).toThrow('active client credential');
});

it('merges scoped approvals without overwriting unrelated grants and invalidates stale renewals', async () => {
  const { access, owner } = await fixture();
  const enrollment = access.request({ label: 'Scoped reader', access: 'write', refresh: false }, '', 'test');
  access.setPermissions(owner!.token, enrollment.requestId, 'request', noPermissions());
  access.decide(owner!.token, enrollment.requestId, true);
  const issued = access.claim(enrollment.requestId, enrollment.requestSecret);
  if (!('token' in issued)) throw new Error('Expected client credential');
  const renewal = access.request({ label: 'Ignored', access: 'write', refresh: true }, issued.token, 'test');
  const create = access.requestPermissions(issued.token, [{ category: 'content', operation: 'create' }], 'test');
  const run = access.requestPermissions(issued.token, [{ category: 'tools', operation: 'run' }], 'test');
  if (create.state !== 'pending' || run.state !== 'pending') throw new Error('Expected pending requests');
  access.decide(owner!.token, create.requestId, true);
  access.decide(owner!.token, run.requestId, true);
  expect(access.authenticate(issued.token)?.permissions).toMatchObject({ content: { create: true }, tools: { run: true } });
  expect(() => access.claim(renewal.requestId, renewal.requestSecret)).toThrow('denied');
  expect(access.requestPermissions(issued.token, [{ category: 'content', operation: 'create' }], 'test')).toEqual({ state: 'granted' });
});

it('uses the same scoped approval for HTTP attachments and portable MCP image uploads', async () => {
  const { access, owner, connect, server } = await fixture();
  const enrollment = access.request({ label: 'Image reporter', access: 'write', refresh: false }, '', 'test');
  const initial = noPermissions();
  initial.content.read = true;
  access.setPermissions(owner!.token, enrollment.requestId, 'request', initial);
  access.decide(owner!.token, enrollment.requestId, true);
  const issued = access.claim(enrollment.requestId, enrollment.requestSecret);
  if (!('token' in issued)) throw new Error('Expected client credential');
  const headers = { authorization: `Bearer ${issued.token}`, 'content-type': 'image/png' };
  const denied = await fetch(`${server.url}/attachments`, { method: 'POST', headers, body: Buffer.from([137, 80, 78, 71]) });
  expect(denied.status).toBe(403);
  const request = access.snapshot(owner!.token).requests[0];
  const client = await connect(issued.token);
  const image = Buffer.alloc(700 * 1024, 1);
  const upload = (data = image.toString('base64'), mimeType = 'image/png') => client.callTool({
    name: 'wm-attachment-create', arguments: { filename: 'screenshot.png', mimeType, data },
  });
  await expect(upload()).rejects.toThrow('Additional access requested');
  expect(access.snapshot(owner!.token).requests).toHaveLength(1);
  access.decide(owner!.token, String(request.id), true);
  const attachment = value(await upload());
  expect(attachment).toMatchObject({ size: image.length, reference: `wm-attachment:${attachment.id}` });
  const stored = await fetch(`${server.url}/attachments/${attachment.id}`, { headers });
  expect(Buffer.from(await stored.arrayBuffer())).toEqual(image);
  expect((await upload(Buffer.alloc(700 * 1024 + 1).toString('base64'))).isError).toBe(true);
  expect((await upload('AB==')).isError).toBe(true);
  expect((await upload('', 'text/plain')).isError).toBe(true);
});

it('requires an existing identity for explicit permission requests and keeps unknown tools fail-closed', async () => {
  const { access, owner, connect } = await fixture();
  const anonymous = await connect(undefined, '/identity/v1/mcp');
  expect((await anonymous.callTool({ name: 'wm-identity-request-permissions', arguments: {
    permissions: [{ category: 'content', operation: 'create' }],
  } })).isError).toBe(true);
  const enrollment = access.request({ label: 'Requester', access: 'read', refresh: false }, '', 'test');
  access.decide(owner!.token, enrollment.requestId, true);
  const issued = access.claim(enrollment.requestId, enrollment.requestSecret);
  if (!('token' in issued)) throw new Error('Expected client credential');
  const client = await connect(issued.token, '/identity/v1/mcp');
  expect(value(await client.callTool({ name: 'wm-identity-request-permissions', arguments: {
    permissions: [{ category: 'content', operation: 'create' }],
  } }))).toMatchObject({ state: 'pending' });
  expect((await client.callTool({ name: 'wm-identity-request-permissions', arguments: {
    permissions: [{ category: 'content', operation: 'run' }],
  } })).isError).toBe(true);
});

it('edits pending permissions, filters mixed reads, and enforces changes on an existing MCP session', async () => {
  const { access, owner, connect, store, server } = await fixture();
  const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Visible topic' } });
  const config = store.createDocument({ kind: 'Config', spec: { id: 'Private settings' } });
  const image = store.createAttachment({ mimeType: 'image/png', filename: 'test.png', data: Buffer.from([137, 80, 78, 71]) });
  const request = access.request({ label: 'Content reader', access: 'write', refresh: false }, '', 'test');
  const permissions = noPermissions();
  permissions.content.read = true;
  access.setPermissions(owner!.token, request.requestId, 'request', permissions);
  access.decide(owner!.token, request.requestId, true);
  const issued = access.claim(request.requestId, request.requestSecret);
  if (!('token' in issued)) throw new Error('Expected approved token');
  expect(access.snapshot(owner!.token).requests).toEqual([]);
  const reader = await connect(issued.token);
  expect(value(await reader.callTool({ name: 'wm-document-read', arguments: {} }))).toMatchObject({
    count: 1, documents: [{ metadata: { id: topic.metadata.id } }],
  });
  for (const args of [{ id: config.metadata.id }, { kind: 'Config' }, { id: config.metadata.id, kind: 'Topic' }]) {
    await expect(reader.callTool({ name: 'wm-document-read', arguments: args })).rejects.toThrow(/permission/i);
  }
  await expect(reader.callTool({ name: 'ws-config-read', arguments: {} })).rejects.toThrow(/permission/i);
  const imageUrl = `${server.url}/attachments/${image.id}`;
  const headers = { Authorization: `Bearer ${issued.token}` };
  const imageResponse = await fetch(imageUrl, { headers });
  expect(imageResponse.status).toBe(200);
  expect(imageResponse.headers.get('cache-control')).toContain('no-store');
  permissions.content.read = false;
  permissions.settings.read = true;
  access.setPermissions(owner!.token, issued.clientId, 'client', permissions);
  expect(value(await reader.callTool({ name: 'wm-document-read', arguments: {} }))).toMatchObject({
    count: 1, documents: [{ metadata: { id: config.metadata.id } }],
  });
  await expect(reader.callTool({ name: 'ws-topic-read', arguments: {} })).rejects.toThrow(/permission/i);
  expect((await fetch(`${server.url}/changes`, { headers: { Authorization: `Bearer ${issued.token}` } })).status).toBe(403);
  expect((await fetch(imageUrl, { headers })).status).toBe(403);
  const recovered = new InstanceAccess(store.db, new InstanceIdentity(store.db));
  expect(recovered.authenticate(issued.token)?.permissions).toEqual(permissions);
});

it('checks every category/action independently, including generic IDs, restore, domain mutations, and unknown tools', async () => {
  const { store } = await fixture();
  const config = store.createDocument({ kind: 'Config', spec: { id: 'Settings' } });
  const cases = [
    ['content', 'create', 'ws-topic-create'], ['content', 'read', 'ws-workstream-read'],
    ['content', 'update', 'ws-agent-message-resolve'], ['content', 'delete', 'ws-alert-delete'],
    ['settings', 'create', 'ws-agent-create'], ['settings', 'read', 'ws-topictype-read'],
    ['settings', 'update', 'ws-containerclaim-update'], ['settings', 'delete', 'ws-config-delete'],
    ...(['create', 'read', 'update', 'delete', 'run'] as const).map(operation => ['tools', operation, `wm-host-task-${operation}`]),
  ] as const;
  for (const [category, operation, name] of cases) {
    const permissions = noPermissions();
    if (operation === 'run') permissions.tools.run = true;
    else permissions[category as keyof InstancePermissions][operation as 'create' | 'read' | 'update' | 'delete'] = true;
    const principal = { key: 'test', role: 'client' as const, access: 'write' as const, permissions };
    for (const [otherCategory, otherOperation, otherName] of cases) {
      expect(authorizeInstanceTool(principal, otherName, {}, store), `${name} vs ${otherName}`)
        .toBe(category === otherCategory && operation === otherOperation);
    }
    expect(authorizeInstanceTool(principal, 'unrecognized-tool', {}, store)).toBe(false);
    expect(authorizeInstanceTool(principal, 'ws-topic-unknown', {}, store)).toBe(false);
    expect(authorizeInstanceTool(principal, 'wm-document-create', { kind: 'UnknownKind' }, store)).toBe(false);
  }
  const permissions = noPermissions();
  permissions.content.update = true;
  const principal = { key: 'test', role: 'client' as const, access: 'write' as const, permissions };
  expect(authorizeInstanceTool(principal, 'wm-document-update', { id: config.metadata.id, kind: 'Topic' }, store)).toBe(false);
  expect(authorizeInstanceTool(principal, 'wm-document-delete', { kind: 'Topic', restore: true }, store)).toBe(true);
  expect(authorizeInstanceTool(principal, 'ws-agent-message-restore', {}, store)).toBe(true);
  expect(authorizeInstanceTool(principal, 'ws-topic-transfer', {}, store)).toBe(false);
  permissions.content.create = true;
  expect(authorizeInstanceTool(principal, 'ws-topic-transfer', {}, store)).toBe(true);
});

it('preserves legacy read/write document access without granting any Tools permission', async () => {
  const { access, owner, store } = await fixture();
  for (const level of ['read', 'write'] as const) {
    const request = access.request({ label: 'Legacy client', access: level, refresh: false }, '', 'test');
    access.decide(owner!.token, request.requestId, true);
    const issued = access.claim(request.requestId, request.requestSecret);
    if (!('token' in issued)) throw new Error('Expected approved credential');
    store.db.prepare('UPDATE instance_clients SET permissions=NULL WHERE id=?').run(issued.clientId);
    expect(access.authenticate(issued.token)?.permissions).toEqual(defaultInstancePermissions(level));
    expect(access.authenticate(issued.token)?.permissions.tools).toEqual(noPermissions().tools);
  }
});

it('keeps only the latest renewal actionable so an earlier approval cannot restore older permissions', async () => {
  const { access, owner } = await fixture();
  const request = access.request({ label: 'Renewing client', access: 'write', refresh: false }, '', 'test');
  access.decide(owner!.token, request.requestId, true);
  const issued = access.claim(request.requestId, request.requestSecret);
  if (!('token' in issued)) throw new Error('Expected approved credential');
  const first = access.request({ label: 'Ignored', access: 'write', refresh: true }, issued.token, 'test');
  access.decide(owner!.token, first.requestId, true);
  const second = access.request({ label: 'Ignored', access: 'write', refresh: true }, issued.token, 'test');
  access.setPermissions(owner!.token, second.requestId, 'request', noPermissions());
  expect(() => access.claim(first.requestId, first.requestSecret)).toThrow(/denied/);
  expect(access.snapshot(owner!.token).requests.filter(row => row.state === 'pending' || row.state === 'approved')).toHaveLength(1);
  access.decide(owner!.token, second.requestId, true);
  const renewed = access.claim(second.requestId, second.requestSecret);
  if (!('token' in renewed)) throw new Error('Expected renewed credential');
  expect(access.authenticate(renewed.token)?.permissions).toEqual(noPermissions());
});

it('prevents a pending renewal from restoring removed permissions and keeps access administration owner-only', async () => {
  const { access, owner, server } = await fixture();
  const request = access.request({ label: 'Writer', access: 'write', refresh: false }, '', 'test');
  access.decide(owner!.token, request.requestId, true);
  const issued = access.claim(request.requestId, request.requestSecret);
  if (!('token' in issued)) throw new Error('Expected approved token');
  const renewal = access.request({ label: 'Ignored', access: 'write', refresh: true }, issued.token, 'test');
  access.decide(owner!.token, renewal.requestId, true);
  access.setPermissions(owner!.token, issued.clientId, 'client', noPermissions());
  expect(() => access.claim(renewal.requestId, renewal.requestSecret)).toThrow(/denied/i);
  expect(() => access.setPermissions(issued.token, issued.clientId, 'client', defaultInstancePermissions('write'))).toThrow(/owner/i);
  expect(() => access.setPermissions(owner!.token, issued.clientId, 'client', { content: {} })).toThrow();
  expect(access.authenticate(issued.token)?.permissions).toEqual(noPermissions());
  const response = await fetch(`${server.url}/identity/v1/access`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${owner!.token}` },
    body: JSON.stringify({ action: 'permissions', id: issued.clientId, target: 'client', permissions: defaultInstancePermissions('read') }),
  });
  expect(response.status).toBe(200);
  expect(access.authenticate(issued.token)?.permissions).toEqual(defaultInstancePermissions('read'));
});

it('blocks every instance-MCP task operation for an authenticated owner until Host Tasks is explicitly enabled', async () => {
  const { owner, connect, store } = await fixture();
  const broker = new HostTaskBroker(store.db);
  expect(broker.features.read()).toEqual({ hostTasks: false });
  const agent = await connect(owner!.token);
  const id = randomUUID();
  const definition = { name: 'Blocked task', description: '', hostId: randomUUID(),
    source: 'module.exports = () => ({});', parameters: {}, timeoutMs: 1000 };
  const operations = [
    { name: 'wm-host-task-read', arguments: {} },
    { name: 'wm-host-task-create', arguments: { definition } },
    { name: 'wm-host-task-update', arguments: { id, definition } },
    { name: 'wm-host-task-delete', arguments: { id } },
    { name: 'wm-host-task-run', arguments: { taskId: id, definitionHash: '0'.repeat(64), parameters: {}, idempotencyKey: 'blocked' } },
    { name: 'wm-host-task-job-read', arguments: { id } },
  ];
  for (const operation of operations) {
    const response = await agent.callTool(operation);
    expect(response.isError, operation.name).toBe(true);
    expect(JSON.stringify(response), operation.name).toContain('host_tasks_feature_disabled');
  }
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM host_script_tasks').get()?.count).toBe(0);
  expect(store.db.prepare('SELECT COUNT(*) AS count FROM host_script_jobs').get()?.count).toBe(0);
  expect(broker.features.read()).toEqual({ hostTasks: false });
});

it('requires Tools Run and exact-version grants, keeps edits as drafts, and invalidates grants on publish or downgrade', async () => {
  const { access, owner, connect, store } = await fixture();
  const broker = new HostTaskBroker(store.db);
  broker.features.write({ hostTasks: true });
  const request = access.request({ label: 'Task caller', access: 'write', refresh: false }, '', 'test');
  const permissions = noPermissions();
  permissions.tools = { create: true, read: true, update: true, delete: true, run: true };
  access.setPermissions(owner!.token, request.requestId, 'request', permissions);
  access.decide(owner!.token, request.requestId, true);
  const issued = access.claim(request.requestId, request.requestSecret);
  if (!('token' in issued)) throw new Error('Expected approved token');
  const agent = await connect(issued.token);
  const definition = { name: 'No-op', description: 'Test', hostId: randomUUID(),
    source: 'module.exports = async () => ({ ok: true });', parameters: {}, timeoutMs: 1000 };
  const task = scriptTaskSchema.parse(value(await agent.callTool({ name: 'wm-host-task-create', arguments: { definition } })));
  const input = { taskId: task.id, definitionHash: task.definitionHash, parameters: {}, idempotencyKey: 'first' };
  expect(await agent.callTool({ name: 'wm-host-task-run', arguments: input })).toMatchObject({ isError: true });
  broker.dispatch('POST', '/admin/scripts/grants', owner!.token, {
    appId: issued.clientId, taskId: task.id, definitionHash: task.definitionHash, expiresAt: Date.now() + 60000,
  });
  const job = scriptJobSchema.parse(value(await agent.callTool({ name: 'wm-host-task-run', arguments: input })));
  expect(job.appId).toBe(issued.clientId);
  expect(job.state).toBe('queued');
  const updated = scriptVersionSchema.parse(value(await agent.callTool({
    name: 'wm-host-task-update', arguments: { id: task.id, definition: { ...definition, description: 'New version' } },
  })));
  expect(updated.definitionHash).not.toBe(task.definitionHash);
  expect(updated.version).toBe(2);
  expect(store.db.prepare('SELECT state FROM host_script_jobs WHERE id=?').get(job.id)?.state).toBe('queued');
  expect(() => broker.dispatchInstanceTask(access.authenticate(issued.token)!, 'GET', `/tasks/${task.id}`)).toThrow('task_route_not_found');
  broker.dispatch('POST', `/admin/scripts/${task.id}/publish`, owner!.token, {
    version: updated.version, expectedPublishedHash: task.definitionHash,
  });
  expect(store.db.prepare('SELECT state FROM host_script_jobs WHERE id=?').get(job.id)?.state).toBe('cancelled');
  const newInput = { ...input, definitionHash: updated.definitionHash, idempotencyKey: 'new-version' };
  expect(await agent.callTool({ name: 'wm-host-task-run', arguments: newInput })).toMatchObject({ isError: true });
  broker.dispatch('POST', '/admin/scripts/grants', owner!.token, {
    appId: issued.clientId, taskId: task.id, definitionHash: updated.definitionHash, expiresAt: Date.now() + 60000,
  });
  const second = scriptJobSchema.parse(value(await agent.callTool({ name: 'wm-host-task-run', arguments: newInput })));
  permissions.tools.run = false;
  access.setPermissions(owner!.token, issued.clientId, 'client', permissions);
  expect(store.db.prepare('SELECT state FROM host_script_jobs WHERE id=?').get(second.id)?.state).toBe('cancelled');
  await expect(agent.callTool({ name: 'wm-host-task-run', arguments: { ...newInput, idempotencyKey: 'denied' } })).rejects.toThrow(/permission/i);
  expect(broker.dispatch('POST', '/admin/scripts/claim', owner!.token, { hostId: definition.hostId }).body).toBeNull();
  expect(() => broker.dispatch('GET', '/scripts', `instance-client:${issued.clientId}`)).toThrow(/credential/i);
  permissions.tools.run = true;
  access.setPermissions(owner!.token, issued.clientId, 'client', permissions);
  const reenabledInput = { ...newInput, idempotencyKey: 'reenabled' };
  expect(await agent.callTool({ name: 'wm-host-task-run', arguments: reenabledInput })).toMatchObject({ isError: true });
  broker.dispatch('POST', '/admin/scripts/grants', owner!.token, {
    appId: issued.clientId, taskId: task.id, definitionHash: updated.definitionHash, expiresAt: Date.now() + 60000,
  });
  const third = scriptJobSchema.parse(value(await agent.callTool({ name: 'wm-host-task-run', arguments: reenabledInput })));
  access.revoke(owner!.token, issued.clientId);
  expect(store.db.prepare('SELECT state FROM host_script_jobs WHERE id=?').get(third.id)?.state).toBe('cancelled');
});

it('blocks data before password setup and gives desktop and agent recovery paths', async () => {
  const { server } = await fixture(false);
  for (const path of ['/mcp', '/attachments', '/attachments/11111111-1111-4111-8111-111111111111', '/changes']) {
    const response = await fetch(new URL(path, server.url));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: 'instance_authentication_required', passwordConfigured: false,
      identityMcpUrl: `${server.url}/identity/v1/mcp`,
    });
  }
  const status = await fetch(`${server.url}/identity/v1/status`).then(response => response.json());
  expect(status).toMatchObject({ passwordConfigured: false, authenticated: false, scope: 'instance' });
  expect((await fetch(`${server.url}/health`)).status).toBe(200);
});

it('requires human owner approval and issues a client token only once through the public identity MCP', async () => {
  const { server, owner, connect, store } = await fixture();
  const enrollment = await connect(undefined, '/identity/v1/mcp');
  const listed = (await enrollment.listTools()).tools.map(tool => tool.name);
  expect(listed).toEqual(['wm-identity-request-access', 'wm-identity-claim-access', 'wm-identity-request-permissions']);
  const request = value(await enrollment.callTool({
    name: 'wm-identity-request-access', arguments: { label: 'My coding agent', access: 'write' },
  }));
  const claim = () => enrollment.callTool({
    name: 'wm-identity-claim-access', arguments: { requestId: request.requestId, requestSecret: request.requestSecret },
  });
  expect(value(await claim()).state).toBe('pending');
  const approval = await fetch(`${server.url}/identity/v1/access`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${owner!.token}` },
    body: JSON.stringify({ action: 'approve', id: request.requestId }),
  });
  expect(approval.status).toBe(200);
  expect(JSON.stringify(await approval.json())).not.toContain(String(request.requestSecret));
  const issued = value(await claim());
  expect(issued.state).toBe('issued');
  expect((await claim()).isError).toBe(true);
  const agent = await connect(String(issued.token));
  expect(value(await agent.callTool({ name: 'wm-ping', arguments: {} })).ok).toBe(true);
  expect((await fetch(`${server.url}/identity/v1/access`, { headers: { Authorization: `Bearer ${issued.token}` } })).status).toBe(401);
  expect((await fetch(`${server.url}/features/v1`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ hostTasks: true }),
  })).status).toBe(200);
  expect((await fetch(`${server.url}/identity/v1/hint`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ passwordHint: 'forbidden' }),
  })).status).toBe(401);
  expect((await fetch(`${server.url}/host-tasks/v1/admin/scripts/claim`, {
    method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${issued.token}` },
    body: JSON.stringify({ hostId: randomUUID() }),
  })).status).toBe(401);
  const rows = JSON.stringify({
    clients: store.db.prepare('SELECT * FROM instance_clients').all(),
    requests: store.db.prepare('SELECT * FROM instance_access_requests').all(),
  });
  expect(rows).not.toContain(String(issued.token));
  expect(rows).not.toContain(String(request.requestSecret));
});

it('denies unapproved, stolen-request, denied, expired, and revoked credentials', async () => {
  const { access, owner, advance } = await fixture();
  const request = access.request({ label: 'Reader', access: 'read', refresh: false }, '', 'test');
  expect(() => access.claim(request.requestId, 'wrong secret')).toThrow('not found');
  expect(() => access.decide('not an owner', request.requestId, true)).toThrow('owner');
  access.decide(owner!.token, request.requestId, false);
  expect(() => access.claim(request.requestId, request.requestSecret)).toThrow('denied');
  const approved = access.request({ label: 'Revoked reader', access: 'read', refresh: false }, '', 'test');
  access.decide(owner!.token, approved.requestId, true);
  const issued = access.claim(approved.requestId, approved.requestSecret);
  if (!('token' in issued)) throw new Error('Expected approved token');
  access.revoke(owner!.token, issued.clientId);
  expect(access.authenticate(issued.token)).toBeNull();
  expect(() => access.request({ label: 'Refresh', access: 'write', refresh: true }, issued.token, 'test')).toThrow('Revoked');
  const expired = access.request({ label: 'Expired', access: 'read', refresh: false }, '', 'test');
  advance(10 * 60 * 1000);
  expect(() => access.claim(expired.requestId, expired.requestSecret)).toThrow('expired');
});

it('enforces read-only data access while permitting document reads and authenticated attachments', async () => {
  const { access, owner, connect, server, store } = await fixture();
  store.createDocument({ kind: 'Config', spec: { id: 'visible' } });
  const request = access.request({ label: 'Reader', access: 'read', refresh: false }, '', 'test');
  access.decide(owner!.token, request.requestId, true);
  const issued = access.claim(request.requestId, request.requestSecret);
  if (!('token' in issued)) throw new Error('Expected approved token');
  const reader = await connect(issued.token);
  expect(value(await reader.callTool({ name: 'wm-document-read', arguments: {} })).count).toBe(1);
  await expect(reader.callTool({ name: 'wm-document-create', arguments: { kind: 'Config', spec: { key: 'forbidden' } } })).rejects.toThrow(/permission/i);
  expect((await fetch(`${server.url}/attachments`, {
    method: 'POST', headers: { Authorization: `Bearer ${issued.token}`, 'content-type': 'image/png' }, body: 'not uploaded',
  })).status).toBe(403);
});

it('allows owner-approved refresh of expired clients, rotates credentials, and never upgrades permissions implicitly', async () => {
  const { access, identity, owner, advance, now } = await fixture();
  const request = access.request({ label: 'Reader', access: 'read', refresh: false }, '', 'test');
  access.decide(owner!.token, request.requestId, true);
  const first = access.claim(request.requestId, request.requestSecret);
  if (!('token' in first)) throw new Error('Expected approved token');
  expect(first.expiresAt - now()).toBe(90 * 24 * 60 * 60 * 1000);
  advance(90 * 24 * 60 * 60 * 1000 - 1);
  expect(access.authenticate(first.token)).toMatchObject({ role: 'client', access: 'read' });
  expect(identity.authenticate(owner!.token)).toBe(false);
  advance(1);
  expect(access.authenticate(first.token)).toBeNull();
  const refresh = access.request({ label: 'Forged owner name', access: 'write', refresh: true }, first.token, 'test');
  expect(access.claim(refresh.requestId, refresh.requestSecret).state).toBe('pending');
  const newOwner = await identity.login({ password });
  expect(access.snapshot(newOwner.token).requests[0]).toMatchObject({ label: 'Reader', access: 'read', clientId: first.clientId });
  access.decide(newOwner.token, refresh.requestId, true);
  const second = access.claim(refresh.requestId, refresh.requestSecret);
  if (!('token' in second)) throw new Error('Expected refreshed token');
  expect(second.token).not.toBe(first.token);
  expect(second.clientId).toBe(first.clientId);
  expect(access.authenticate(second.token)).toMatchObject({ role: 'client', access: 'read' });
  expect(access.authenticate(first.token)).toBeNull();
});

it('binds MCP sessions to a credential and rechecks revocation and delayed change responses', async () => {
  const { server, identity, owner, store } = await fixture();
  const other = await identity.login({ password });
  const initialized = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${owner!.token}`, 'content-type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'owner', version: '1' } } }),
  });
  const sessionId = initialized.headers.get('mcp-session-id')!;
  expect(sessionId).toBeTruthy();
  const response = await fetch(`${server.url}/mcp`, {
    method: 'POST', headers: { Authorization: `Bearer ${other.token}`, 'mcp-session-id': sessionId, 'content-type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
  expect(response.status).toBe(403);
  const version = store.getResourceVersion();
  const waiting = fetch(`${server.url}/changes?since=${version}`, { headers: { Authorization: `Bearer ${owner!.token}` } });
  await new Promise(resolve => setTimeout(resolve, 50));
  identity.revoke(owner!.token);
  store.createDocument({ kind: 'Config', spec: { secret: 'not in response' } });
  expect((await waiting).status).toBe(401);
});
