import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server';
import { openStore } from '../src/store';
import { InstanceIdentity } from '../src/instanceIdentity';
import { InstanceAccess } from '../src/instanceAccess';
import { loadKinds } from '../src/kinds/loader';
import { getKind } from '../src/kinds/registry';
import { DEFAULT_SESSION_POLICY, sessionSnapshotSchema } from '../src/sessionPolicy';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => { await loadKinds(); });
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const store = openStore(':memory:');
  let now = Date.now(), used = 100;
  const identity = new InstanceIdentity(store.db, () => now);
  const owner = await identity.initialize('private session test password');
  const access = new InstanceAccess(store.db, identity, () => now);
  const server = await startServer({
    port: 0, store, hostTaskClock: () => now,
    sessionDiagnostics: { clock: () => now, memory: () => ({ used, limit: 1000 }) },
  });
  cleanup.push(async () => { await server.close(); store.close(); });
  const request = (path: string, init: RequestInit = {}, token = owner.token) => {
    const headers = new Headers(init.headers);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return fetch(new URL(path, server.url), { ...init, headers });
  };
  const snapshot = async () => sessionSnapshotSchema.parse(await (await request('/identity/v1/sessions')).json());
  const policy = (patch: Partial<typeof DEFAULT_SESSION_POLICY>) => request('/identity/v1/sessions', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...DEFAULT_SESSION_POLICY, ...patch }),
  });
  const enroll = () => {
    const enrollment = access.request({ label: 'Approved test container', access: 'write', refresh: false }, '', 'test');
    access.decide(owner.token, enrollment.requestId, true);
    const issued = access.claim(enrollment.requestId, enrollment.requestSecret);
    if (!('token' in issued)) throw new Error('Expected approved credential');
    return issued;
  };
  const connect = async (token = owner.token) => {
    const client = new Client({ name: 'session-http-test', version: '1' });
    const transport = new StreamableHTTPClientTransport(new URL('/mcp', server.url), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      fetch: (input, init) => init?.method === 'GET'
        ? Promise.resolve(new Response(null, { status: 405 })) : fetch(input, init),
    });
    cleanup.push(() => client.close());
    await client.connect(transport);
    return { client, transport };
  };
  const data = () => {
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp`, getToken: () => owner.token });
    cleanup.push(() => client.dispose());
    return client;
  };
  return { store, owner, access, server, request, snapshot, policy, enroll, connect, data,
    advance: (ms: number) => { now += ms; }, memory: (bytes: number) => { used = bytes; } };
}

it('restricts diagnostics and policy to trusted owner requests and hides all protocol credentials', async () => {
  const f = await fixture(), issued = f.enroll();
  expect((await f.request('/identity/v1/sessions', {}, '')).status).toBe(401);
  expect((await f.request('/identity/v1/sessions', {}, issued.token)).status).toBe(401);
  expect((await f.request('/identity/v1/sessions', { headers: { origin: 'http://untrusted.invalid' } })).status).toBe(400);
  expect((await f.request('/identity/v1/sessions?token=forbidden')).status).toBe(400);
  expect((await f.request('/identity/v1/sessions?before=-1')).status).toBe(400);
  expect((await f.policy({ idleMinutes: 0 })).status).toBe(400);
  const { transport } = await f.connect(issued.token);
  const snapshot = await f.snapshot();
  expect(snapshot.active).toHaveLength(1);
  expect(snapshot.active[0]).toMatchObject({ clientLabel: 'Approved test container', application: 'session-http-test' });
  const serialized = JSON.stringify(snapshot);
  for (const secret of [f.owner.token, issued.token, transport.sessionId!, f.access.authenticate(issued.token)!.key]) {
    expect(serialized).not.toContain(secret);
  }
  expect((await f.policy({ idleMinutes: 75 })).status).toBe(200);
  expect((await f.snapshot()).policy.idleMinutes).toBe(75);
});

it('releases instance-bound sessions on switching away and reconnects at a one-session cap', async () => {
  const first = await fixture(), second = await fixture();
  await first.policy({ maxPerClient: 1, maxTotal: 1 });
  await second.policy({ maxPerClient: 1, maxTotal: 1 });
  let selected = first;
  const client = () => {
    const connected = new ControlPlaneClient({
      resolveUrl: () => `${selected.server.url}/mcp`,
      getToken: url => url === `${first.server.url}/mcp` ? first.owner.token : second.owner.token,
    });
    cleanup.push(() => connected.dispose());
    return connected;
  };
  const original = client();
  expect((await original.listDocuments()).available).toBe(true);
  expect((await first.snapshot()).active).toHaveLength(1);
  selected = second;
  await original.dispose();
  expect((await first.snapshot()).active).toEqual([]);
  expect((await first.snapshot()).events[0].type).toBe('closed');
  const other = client();
  expect((await other.listDocuments()).available).toBe(true);
  selected = first;
  await other.dispose();
  expect((await second.snapshot()).active).toEqual([]);
  const replacement = client();
  expect((await replacement.listDocuments()).available).toBe(true);
  expect((await first.snapshot()).active).toHaveLength(1);
});

it('waits for a pending initialization to release its session during disposal', async () => {
  const f = await fixture(), client = f.data();
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const response = await original(input, init);
    if (init?.method === 'POST' && typeof init.body === 'string' && init.body.includes('"method":"initialize"')) {
      started(); await waiting;
    }
    return response;
  });
  let disposed = false;
  try {
    const pending = client.listDocuments();
    await running;
    const stopping = client.dispose().then(() => { disposed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disposed).toBe(false);
    release();
    expect((await pending).available).toBe(false);
    await stopping;
    expect((await f.snapshot()).active).toEqual([]);
    expect((await f.snapshot()).events[0].type).toBe('closed');
  } finally { release(); }
});

it('expires real MCP transports with 404, preserves approval, and admits a new authenticated session', async () => {
  const f = await fixture(), issued = f.enroll();
  await f.policy({ idleMinutes: 1 });
  const { client } = await f.connect(issued.token);
  f.advance(60001);
  await expect(client.callTool({ name: 'wm-ping', arguments: {} })).rejects.toMatchObject({ code: 404 });
  expect((await f.snapshot()).active).toEqual([]);
  expect((await f.snapshot()).events[0].type).toBe('idle_expired');
  expect(f.access.authenticate(issued.token)).not.toBeNull();
  expect((await f.connect(issued.token)).transport.sessionId).toBeTruthy();
});

it('does not expire an actual asynchronous tool request while its JSON response is pending', async () => {
  const f = await fixture(), kind = getKind('Topic');
  if (!kind) throw new Error('Topic kind is not loaded');
  const original = kind.registerApi;
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  kind.registerApi = (server, store) => {
    original?.(server, store);
    server.registerTool('test-wait', { inputSchema: {} }, async () => {
      started(); await waiting;
      return { content: [{ type: 'text', text: 'completed' }] };
    });
  };
  try {
    await f.policy({ idleMinutes: 1 });
    const { client } = await f.connect();
    const pending = client.callTool({ name: 'test-wait', arguments: {} });
    await running;
    f.advance(120000);
    await f.policy({ idleMinutes: 1 });
    expect((await f.snapshot()).active[0].activeRequests).toBe(1);
    release();
    expect((await pending).isError).not.toBe(true);
    expect((await f.snapshot()).active[0].activeRequests).toBe(0);
    expect((await f.snapshot()).active).toHaveLength(1);
  } finally { release(); kind.registerApi = original; }
});

it.each([
  { label: 'valid', body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'wm-ping', arguments: {} } }), status: 200 },
  { label: 'malformed', body: '{"jsonrpc":', status: 400 },
])('protects a $label POST body from idle expiry and releases activity afterwards', async ({ body, status }) => {
  const f = await fixture();
  await f.policy({ idleMinutes: 1 });
  const { transport } = await f.connect();
  const before = (await f.snapshot()).active[0].requests;
  f.advance(59999);
  const encoder = new TextEncoder();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST', duplex: 'half',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-session-id': transport.sessionId! },
    body: new ReadableStream<Uint8Array>({
      start(controller) { stream = controller; controller.enqueue(encoder.encode(body.slice(0, -1))); },
    }),
  };
  const pending = f.request('/mcp', init);
  let completed = false;
  const finish = () => {
    if (completed) return;
    completed = true;
    stream.enqueue(encoder.encode(body.slice(-1)));
    stream.close();
  };
  try {
    await vi.waitFor(async () => { expect((await f.snapshot()).active[0].activeRequests).toBe(1); });
    f.advance(120000);
    await f.policy({ idleMinutes: 1 });
    expect((await f.snapshot()).events.some(event => event.type === 'idle_expired')).toBe(false);
    finish();
    const response = await pending;
    expect(response.status).toBe(status);
    await response.text();
    expect((await f.snapshot()).active[0]).toMatchObject({ activeRequests: 0, requests: before + 1 });
    f.advance(60001);
    await f.policy({ idleMinutes: 1 });
    expect((await f.snapshot()).events.filter(event => event.type === 'idle_expired')).toHaveLength(1);
  } finally {
    finish();
    const response = await pending;
    if (!response.bodyUsed) await response.body?.cancel();
  }
});

it('cleans up an idle session with an open notification stream rather than treating SSE as a busy tool', async () => {
  const f = await fixture();
  await f.policy({ idleMinutes: 1 });
  const { transport } = await f.connect();
  const response = await f.request('/mcp', { headers: {
    accept: 'text/event-stream', 'mcp-session-id': transport.sessionId!, 'mcp-protocol-version': '2025-11-25',
  }, signal: AbortSignal.timeout(5000) });
  try {
    expect(response.status).toBe(200);
    expect((await f.snapshot()).active[0].activeRequests).toBe(0);
    f.advance(120000);
    await f.policy({ idleMinutes: 1 });
    expect((await f.snapshot()).active).toEqual([]);
  } finally { await response.body?.cancel(); }
});

it('binds sessions to their credential and handles explicit termination without retaining a session', async () => {
  const f = await fixture(), issued = f.enroll();
  const { transport } = await f.connect();
  const wrongOwner = await f.request('/mcp', { method: 'DELETE', headers: { 'mcp-session-id': transport.sessionId! } }, issued.token);
  expect(wrongOwner.status).toBe(403);
  await transport.terminateSession();
  expect((await f.snapshot()).active).toEqual([]);
  expect((await f.snapshot()).events[0].type).toBe('closed');
  for (const method of ['GET', 'DELETE', 'POST']) {
    const response = await f.request('/mcp', { method, headers: {
      'mcp-session-id': 'expired-id', 'content-type': 'application/json',
    }, ...(method === 'POST' ? { body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) } : {}) });
    expect(response.status).toBe(404);
  }
});

it('enforces count and heap admission limits on real handshakes while keeping current sessions usable', async () => {
  const f = await fixture();
  await f.policy({ maxPerClient: 1, maxTotal: 2 });
  const first = await f.connect();
  await expect(f.connect()).rejects.toMatchObject({ code: 429 });
  const issued = f.enroll();
  f.memory(600);
  await expect(f.connect(issued.token)).rejects.toMatchObject({ code: 503 });
  expect((await f.snapshot()).events[0].type).toBe('memory_rejected');
  expect((await first.client.callTool({ name: 'wm-ping', arguments: {} })).isError).not.toBe(true);
  f.memory(599);
  await f.connect(issued.token);
  await expect(f.connect(f.enroll().token)).rejects.toMatchObject({ code: 503 });
  expect((await f.snapshot()).events[0].type).toBe('global_quota');
  expect((await f.snapshot()).active).toHaveLength(2);
});

it('recovers the first document, catalog, and AgentMessage read after expiry without user retry', async () => {
  const f = await fixture(), data = f.data();
  expect((await data.listDocuments()).available).toBe(true);
  for (const read of [
    () => data.agentMessageRead({}),
    () => data.listDocuments(),
    () => data.getDocument({ kind: 'Topic', id: '00000000-0000-4000-8000-000000000001' }),
    () => data.listTools(),
  ]) {
    f.advance(61 * 60000);
    const result = await read();
    expect(result).toBeDefined();
    if (!Array.isArray(result)) expect(result.available).toBe(true);
    expect((await f.snapshot()).active).toHaveLength(1);
  }
});

it('never replays generic calls or typed and document writes after expiration', async () => {
  const f = await fixture(), data = f.data();
  await data.listDocuments();
  f.advance(61 * 60000);
  expect((await data.createDocument({ kind: 'Workstream', spec: { title: 'No replay' } })).available).toBe(false);
  await data.listDocuments();
  f.advance(61 * 60000);
  await expect(data.wsCreate({ title: 'No typed replay' })).rejects.toThrow('Session not found');
  await data.listDocuments();
  f.advance(61 * 60000);
  expect((await data.callTool('wm-document-read', {})).ok).toBe(false);
  expect(f.store.listDocuments({ kind: 'Workstream' })).toEqual([]);
});

it('recovers concurrent reads through a single replacement connection', async () => {
  const f = await fixture(), data = f.data();
  await data.listDocuments();
  f.advance(61 * 60000);
  const [documents, messages, tools] = await Promise.all([
    data.listDocuments(), data.agentMessageRead(), data.listTools(),
  ]);
  expect(documents.available).toBe(true);
  expect(messages).toEqual([]);
  expect(tools.length).toBeGreaterThan(0);
  expect((await f.snapshot()).active).toHaveLength(1);
});
it.each([400, 403, 429, 500])('does not retry unrelated HTTP %i read failures', async status => {
  const f = await fixture(), data = f.data();
  await data.listDocuments();
  const realFetch = globalThis.fetch;
  let calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.body && String(init.body).includes('"name":"wm-document-read"')) {
      calls += 1;
      return new Response('Unrelated failure', { status });
    }
    return realFetch(input, init);
  });
  expect((await data.listDocuments()).available).toBe(false);
  expect(calls).toBe(1);
});

it('retries a recognized stale read at most once, including the legacy stale-session response', async () => {
  const f = await fixture(), data = f.data();
  await data.listDocuments();
  const realFetch = globalThis.fetch;
  let calls = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (init?.body && String(init.body).includes('"name":"wm-document-read"')) {
      calls += 1;
      return new Response(JSON.stringify({
        jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: no valid session ID' }, id: null,
      }), { status: 400 });
    }
    return realFetch(input, init);
  });
  expect((await data.listDocuments()).available).toBe(false);
  expect(calls).toBe(2);
});

it('reclaims a reserved session when registering its tools fails', async () => {
  const f = await fixture(), kind = getKind('Topic');
  if (!kind) throw new Error('Topic kind is not loaded');
  const register = kind.registerApi;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  kind.registerApi = () => { throw new Error('Test registration failure'); };
  try {
    await expect(f.connect()).rejects.toMatchObject({ code: 500 });
    const snapshot = await f.snapshot();
    expect(snapshot.active).toEqual([]);
    expect(snapshot.events[0].type).toBe('initialization_failed');
  } finally { kind.registerApi = register; }
});

it('correlates rate-limit responses with Retry-After and recovers in the next window', async () => {
  const f = await fixture();
  await f.policy({ handshakesPerMinute: 1 });
  await (await f.connect()).transport.terminateSession();
  const response = await f.request('/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'rate-test', method: 'initialize', params: {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'rate-test', version: '1' },
    } }),
  });
  expect(response.status).toBe(429);
  expect(response.headers.get('retry-after')).toBe('60');
  expect(await response.json()).toMatchObject({ id: 'rate-test', error: { code: -32000 } });
  f.advance(60000);
  await (await f.connect()).transport.terminateSession();
  expect((await f.snapshot()).events.filter(event => event.type === 'rate_limited')).toHaveLength(1);
});
