import { afterEach, beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStore } from '../src/store';
import { startServer } from '../src/server';
import { InstanceIdentity } from '../src/instanceIdentity';
import { InstanceAccess } from '../src/instanceAccess';
import { loadKinds } from '../src/kinds/loader';

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
  return { store, identity, owner, access, server, connect, advance: (ms: number) => { now += ms; } };
}

function value(result: unknown): Record<string, unknown> {
  const parsed = result as { content: Array<{ text?: string }> };
  return JSON.parse(parsed.content.find(item => item.text)?.text ?? '{}');
}

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
  expect(listed).toEqual(['wm-identity-request-access', 'wm-identity-claim-access']);
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
  await expect(reader.callTool({ name: 'wm-document-create', arguments: { kind: 'Config', spec: { key: 'forbidden' } } })).rejects.toThrow(/read-only/i);
  expect((await fetch(`${server.url}/attachments`, {
    method: 'POST', headers: { Authorization: `Bearer ${issued.token}`, 'content-type': 'image/png' }, body: 'not uploaded',
  })).status).toBe(403);
});

it('allows owner-approved refresh of expired clients, rotates credentials, and never upgrades permissions implicitly', async () => {
  const { access, identity, owner, advance } = await fixture();
  const request = access.request({ label: 'Reader', access: 'read', refresh: false }, '', 'test');
  access.decide(owner!.token, request.requestId, true);
  const first = access.claim(request.requestId, request.requestSecret);
  if (!('token' in first)) throw new Error('Expected approved token');
  advance(12 * 60 * 60 * 1000);
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
