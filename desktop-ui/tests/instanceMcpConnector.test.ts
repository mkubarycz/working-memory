import { randomBytes } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { startServer } from '../../control-plane/src/server';
import { openStore } from '../../control-plane/src/store';
import { InstanceIdentity } from '../../control-plane/src/instanceIdentity';
import { InstanceAccess } from '../../control-plane/src/instanceAccess';
import { InstanceMcpConnector } from '../src/main/instanceMcpConnector';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => { await loadKinds(); });
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });

async function fixture() {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = openStore(':memory:');
  const identity = new InstanceIdentity(store.db), owner = await identity.initialize('private connector owner password');
  const access = new InstanceAccess(store.db, identity);
  const server = await startServer({ port: 0, store });
  cleanup.push(async () => { await server.close(); store.close(); });
  let saved: string | null = null;
  const credentials = {
    read: vi.fn(async () => saved),
    save: vi.fn(async (_origin: string, value: string) => { saved = value; }),
    forget: vi.fn(async () => { saved = null; }),
    available: vi.fn(() => true),
  };
  async function connect() {
    const connector = new InstanceMcpConnector({ mcpUrl: `${server.url}/mcp`, credentials, pollIntervalMs: 5 });
    const [local, remote] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'VS Code connector test', version: '1' });
    await connector.start(remote);
    await client.connect(local);
    cleanup.push(async () => { await client.close(); await connector.close(); });
    return { connector, client };
  }
  return { store, identity, owner, access, server, credentials, connect };
}

it('exposes no data tools until human approval, then forwards topic reads/writes without exposing credentials', async () => {
  const f = await fixture(), { connector, client } = await f.connect();
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['wm-connection-status', 'wm-request-access']);
  await vi.waitFor(() => expect(connector.status().requestId).toBeTruthy());
  expect(JSON.stringify(await client.callTool({ name: 'wm-connection-status' }))).not.toContain('requestSecret');
  expect((await client.callTool({ name: 'ws-topic-read', arguments: {} })).isError).toBe(true);
  expect(f.credentials.save).not.toHaveBeenCalled();
  f.access.decide(f.owner.token, connector.status().requestId!, true);
  await vi.waitFor(() => expect(connector.status().state).toBe('connected'));
  expect(f.credentials.save).toHaveBeenCalledWith(f.server.url, expect.any(String));
  expect((await client.listTools()).tools.some(tool => tool.name === 'ws-topic-create')).toBe(true);
  f.store.createDocument({ kind: 'TopicType', spec: { label: 'Topic', icon: 'symbol-key' } });
  const created = await client.callTool({ name: 'ws-topic-create', arguments: { title: 'Connector isolated test' } });
  expect(created.isError).not.toBe(true);
  const read = await client.callTool({ name: 'ws-topic-read', arguments: { query: 'Connector isolated test' } });
  expect(JSON.stringify(read)).toContain('Connector isolated test');
  const persistedToken = JSON.parse(f.credentials.save.mock.calls[0][1]).token;
  expect(JSON.stringify(await client.callTool({ name: 'wm-connection-status' }))).not.toContain(persistedToken);
  expect(JSON.stringify(await client.listTools())).not.toContain(persistedToken);
});

it('restores the approved client across connector restarts without another approval request', async () => {
  const f = await fixture(), first = await f.connect();
  await vi.waitFor(() => expect(first.connector.status().requestId).toBeTruthy());
  f.access.decide(f.owner.token, first.connector.status().requestId!, true);
  await vi.waitFor(() => expect(first.connector.status().state).toBe('connected'));
  await first.client.close();
  await first.connector.close();
  const next = await f.connect();
  await vi.waitFor(() => expect(next.connector.status().state).toBe('connected'));
  expect(f.access.snapshot(f.owner.token).clients).toHaveLength(1);
  expect(f.credentials.save).toHaveBeenCalledTimes(1);
});

it.each(['revoked', 'expired'])('disconnects %s access and requests a fresh owner approval without deleting credential files manually', async reason => {
  const f = await fixture(), { connector, client } = await f.connect();
  await vi.waitFor(() => expect(connector.status().requestId).toBeTruthy());
  f.access.decide(f.owner.token, connector.status().requestId!, true);
  await vi.waitFor(() => expect(connector.status().state).toBe('connected'));
  const previous = f.access.snapshot(f.owner.token).clients[0];
  if (reason === 'revoked') f.access.revoke(f.owner.token, String(previous.id));
  else f.store.db.prepare('UPDATE instance_clients SET expires_at=? WHERE id=?').run(Date.now() - 1, String(previous.id));
  await expect(client.callTool({ name: 'wm-ping', arguments: {} })).rejects.toThrow();
  expect(connector.status().state).toBe('disconnected');
  expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['wm-connection-status', 'wm-request-access']);
  await client.callTool({ name: 'wm-request-access', arguments: {} });
  await vi.waitFor(() => expect(connector.status().requestId).toBeTruthy());
  expect(connector.status().state).toBe('awaiting_owner_approval');
  expect(f.credentials.forget).toHaveBeenCalledWith(f.server.url);
  expect(f.credentials.save).toHaveBeenCalledTimes(1);
  f.access.decide(f.owner.token, connector.status().requestId!, true);
  await vi.waitFor(() => expect(connector.status().state).toBe('connected'));
  expect(f.credentials.save).toHaveBeenCalledTimes(2);
  expect((await client.callTool({ name: 'wm-ping', arguments: {} })).isError).not.toBe(true);
});

it('forgets a rejected saved credential on restart and waits for a new owner approval', async () => {
  const f = await fixture(), first = await f.connect();
  await vi.waitFor(() => expect(first.connector.status().requestId).toBeTruthy());
  f.access.decide(f.owner.token, first.connector.status().requestId!, true);
  await vi.waitFor(() => expect(first.connector.status().state).toBe('connected'));
  f.access.revoke(f.owner.token, String(f.access.snapshot(f.owner.token).clients[0].id));
  await first.client.close();
  await first.connector.close();
  const next = await f.connect();
  await vi.waitFor(() => expect(next.connector.status().requestId).toBeTruthy());
  expect(next.connector.status().state).toBe('awaiting_owner_approval');
  expect(f.credentials.forget).toHaveBeenCalledWith(f.server.url);
  expect((await next.client.listTools()).tools).toHaveLength(2);
  expect(f.credentials.save).toHaveBeenCalledTimes(1);
});

it('keeps the connector signed in while missing Create access is requested and approved on its existing record', async () => {
  const f = await fixture(), { connector, client } = await f.connect();
  f.store.createDocument({ kind: 'TopicType', spec: { label: 'Topic', icon: 'symbol-key' } });
  await vi.waitFor(() => expect(connector.status().requestId).toBeTruthy());
  f.access.decide(f.owner.token, connector.status().requestId!, true);
  await vi.waitFor(() => expect(connector.status().state).toBe('connected'));
  const identity = f.access.snapshot(f.owner.token).clients[0];
  const permissions = structuredClone(identity.permissions);
  permissions.content.create = false;
  f.access.setPermissions(f.owner.token, String(identity.id), 'client', permissions);
  const create = () => client.callTool({ name: 'wm-document-create', arguments: {
    kind: 'Topic', spec: { title: 'Scoped connector test' },
  } });
  await expect(create()).rejects.toThrow('Additional access requested');
  expect(connector.status().state).toBe('connected');
  const request = f.access.snapshot(f.owner.token).requests[0];
  expect(request).toMatchObject({ purpose: 'permissions', clientId: identity.id, permissions: { content: { create: true, read: false } } });
  f.access.decide(f.owner.token, String(request.id), true);
  const created = await create();
  expect(created.isError, JSON.stringify(created)).not.toBe(true);
  expect(f.access.snapshot(f.owner.token).clients).toHaveLength(1);
  expect(f.access.snapshot(f.owner.token).clients[0].id).toBe(identity.id);
  expect(f.credentials.save).toHaveBeenCalledTimes(1);
});

it('stops pending enrollment cleanly without claiming or writing credentials', async () => {
  const f = await fixture(), { connector } = await f.connect();
  await vi.waitFor(() => expect(connector.status().requestId).toBeTruthy());
  await connector.close();
  expect(f.credentials.save).not.toHaveBeenCalled();
  expect(f.access.snapshot(f.owner.token).clients).toHaveLength(0);
});

it('fails explicitly when native encryption is unavailable without issuing access or saving plaintext', async () => {
  const f = await fixture();
  f.credentials.available.mockReturnValue(false);
  const { connector, client } = await f.connect();
  await vi.waitFor(() => expect(connector.status().error).toContain('will not save credentials as plaintext'));
  expect((await client.listTools()).tools).toHaveLength(2);
  expect(f.credentials.save).not.toHaveBeenCalled();
  expect(f.access.snapshot(f.owner.token).requests).toHaveLength(0);
});

it('returns a clear denial and permits a new explicit enrollment attempt', async () => {
  const f = await fixture(), { connector, client } = await f.connect();
  await vi.waitFor(() => expect(connector.status().requestId).toBeTruthy());
  f.access.decide(f.owner.token, connector.status().requestId!, false);
  await vi.waitFor(() => expect(connector.status().error).toContain('denied'));
  await client.callTool({ name: 'wm-request-access', arguments: {} });
  await vi.waitFor(() => expect(connector.status().requestId).toBeTruthy());
  expect(connector.status().state).toBe('awaiting_owner_approval');
});

it('refuses a non-loopback or credential-bearing instance URL', () => {
  const credentials = { available: () => true, read: vi.fn(), save: vi.fn(), forget: vi.fn() };
  expect(() => new InstanceMcpConnector({ mcpUrl: 'http://remote.example/mcp', credentials })).toThrow('loopback');
  expect(() => new InstanceMcpConnector({ mcpUrl: `http://user:${randomBytes(16).toString('hex')}@127.0.0.1:7717/mcp`, credentials })).toThrow('credential-free');
});
