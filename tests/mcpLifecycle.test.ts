import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { Client, SdkHttpError, SdkErrorCode } from '@modelcontextprotocol/client';
import { loadKinds } from '../control-plane/src/kinds/loader';
import { ControlPlaneClient, startServer, fetch as ownerFetch, StreamableHTTPClientTransport } from './authenticatedFixture';
import { closeMcpSession, sessionLifecycleFetch, SESSION_TERMINATION_TIMEOUT_MS, staleSessionRejected } from '../shared/mcpLifecycle';
import { InstanceIdentity } from '../control-plane/src/instanceIdentity';
import { openStore } from '../control-plane/src/store';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(async () => { await loadKinds(); });
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

it('keeps session counts at baseline through more reconnects than the default client quota', async () => {
  const server = await startServer({ port: 0 });
  cleanup.push(() => server.close());
  for (let i = 0; i < 120; i++) {
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    cleanup.push(() => client.dispose());
    expect((await client.listDocuments()).available).toBe(true);
    await Promise.all([client.dispose(), client.dispose()]);
    const snapshot = await (await ownerFetch(`${server.url}/identity/v1/sessions`)).json();
    expect(snapshot.active).toHaveLength(0);
  }
  const snapshot = await (await ownerFetch(`${server.url}/identity/v1/sessions`)).json();
  expect(snapshot.events.filter((event: { type: string }) => event.type.endsWith('_quota'))).toHaveLength(0);
});

it('reclaims the previous session when a failed call resets the shared client', async () => {
  const server = await startServer({ port: 0 });
  cleanup.push(() => server.close());
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
  cleanup.push(() => client.dispose());
  expect((await client.listDocuments()).available).toBe(true);
  const realFetch = globalThis.fetch;
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => { throw new TypeError('Synthetic dropped request'); });
  expect((await client.listDocuments()).available).toBe(false);
  spy.mockImplementation(realFetch);
  await vi.waitFor(async () => {
    expect((await (await ownerFetch(`${server.url}/identity/v1/sessions`)).json()).active).toHaveLength(0);
  });
  expect((await client.listDocuments()).available).toBe(true);
  await client.dispose();
  expect((await (await ownerFetch(`${server.url}/identity/v1/sessions`)).json()).active).toHaveLength(0);
});

it('bounds DELETE cleanup, preserves authentication and still closes locally after a timeout', async () => {
  const server = await startServer({ port: 0 });
  cleanup.push(() => server.close());
  const errors: unknown[] = [];
  const client = new Client({ name: 'bounded-cleanup', version: '1' });
  const lifetime = new AbortController();
  let deletionSignal: AbortSignal | null | undefined;
  let deletes = 0;
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
    fetch: sessionLifecycleFetch((input, init) => {
      if (init?.method !== 'DELETE') return globalThis.fetch(input, init);
      deletes++;
      expect(new Headers(init.headers).has('Authorization')).toBe(true);
      deletionSignal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });
    }, lifetime.signal),
  });
  await client.connect(transport);
  lifetime.abort();
  const localClose = vi.spyOn(client, 'close');
  const start = performance.now();
  await Promise.all([
    closeMcpSession(client, transport, error => errors.push(error)),
    closeMcpSession(client, transport, error => errors.push(error)),
  ]);
  expect(performance.now() - start).toBeGreaterThanOrEqual(SESSION_TERMINATION_TIMEOUT_MS - 20);
  expect(performance.now() - start).toBeLessThan(SESSION_TERMINATION_TIMEOUT_MS + 1000);
  expect(deletionSignal?.aborted).toBe(true);
  expect(deletes).toBe(1);
  expect(errors).toHaveLength(1);
  expect(localClose).toHaveBeenCalledTimes(1);
  expect(transport.sessionId).toBeDefined();
}, 10_000);

it('only recognizes explicit pre-dispatch stale-session responses', () => {
  const httpError = (status: number, message: string) =>
    new SdkHttpError(SdkErrorCode.ClientHttpFailedToOpenStream, message, { status });
  expect(staleSessionRejected(httpError(404, 'Session not found or expired. Initialize a new session.'))).toBe(true);
  expect(staleSessionRejected(httpError(400, '{"message":"Bad Request: no valid session ID"}'))).toBe(true);
  expect(staleSessionRejected(httpError(404, 'Document not found'))).toBe(false);
  expect(staleSessionRejected(httpError(503, 'Unavailable'))).toBe(false);
  expect(staleSessionRejected(new TypeError('fetch failed'))).toBe(false);
});

it('terminates with the original session identity after the credential source changes', async () => {
  const store = openStore(':memory:');
  const identity = new InstanceIdentity(store.db);
  const password = 'test-only instance owner password';
  let token = (await identity.initialize(password)).token;
  const server = await startServer({ port: 0, store });
  cleanup.push(async () => { await server.close(); store.close(); });
  const errors: unknown[] = [];
  const client = new ControlPlaneClient({
    resolveUrl: () => `${server.url}/mcp`, getToken: () => token, onError: error => errors.push(error),
  });
  cleanup.push(() => client.dispose());
  expect((await client.listDocuments()).available).toBe(true);
  token = (await identity.login({ password })).token;
  await client.dispose();
  const snapshot = await (await ownerFetch(`${server.url}/identity/v1/sessions`)).json();
  expect(snapshot.active).toHaveLength(0);
  expect(errors).toHaveLength(0);
});

it.each(['quota', 'heap'])('keeps protocol requests and health responsive during %s rejection bursts', async reason => {
  let blocked = false;
  const server = await startServer({ port: 0, sessionDiagnostics: {
    memory: () => ({ used: blocked ? 70 : 10, limit: 100 }),
  } });
  cleanup.push(() => server.close());
  const policy = await ownerFetch(`${server.url}/identity/v1/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idleMinutes: 60, maxPerClient: 1, maxTotal: 1, handshakesPerMinute: 1000, retentionDays: 10 }),
  });
  expect(policy.status).toBe(200);
  const client = new Client({ name: 'rejection-burst-probes', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`));
  await client.connect(transport);
  cleanup.push(() => closeMcpSession(client, transport, error => console.error('MCP probe cleanup failed:', error)));
  const read = () => client.callTool({ name: 'wm-document-read', arguments: {} });
  expect((await read()).isError).not.toBe(true);
  if (reason === 'heap') {
    await ownerFetch(`${server.url}/identity/v1/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idleMinutes: 60, maxPerClient: 100, maxTotal: 100, handshakesPerMinute: 1000, retentionDays: 10 }),
    });
    blocked = true;
  }
  let toolFinished = false;
  const queuedRead = reason === 'heap' ? read().then(result => { toolFinished = true; return result; }) : null;
  const start = performance.now();
  const rejections = Array.from({ length: 50 }, async () => {
    const response = await ownerFetch(`${server.url}/mcp`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'rejected-churn', version: '1' },
      } }),
    });
    expect(response.status).toBe(reason === 'heap' ? 503 : 429);
    expect(Number(response.headers.get('Retry-After'))).toBeGreaterThan(0);
    await response.body?.cancel();
  });
  const probes = Array.from({ length: 10 }, async () => {
    const probeStart = performance.now();
    const [protocol, health] = await Promise.all([client.ping(), globalThis.fetch(`${server.url}/health`)]);
    expect(protocol).toEqual({});
    expect(health.status).toBe(200);
    await health.body?.cancel();
    expect(performance.now() - probeStart).toBeLessThan(1000);
  });
  await Promise.all([...rejections, ...probes]);
  expect(performance.now() - start).toBeLessThan(2000);
  if (queuedRead) {
    expect(toolFinished).toBe(false);
    const queue = await (await ownerFetch(`${server.url}/identity/v1/tool-queue`)).json();
    expect(queue.waiting).toBe(1);
    blocked = false;
    expect((await queuedRead).isError).not.toBe(true);
  } else {
    expect((await read()).isError).not.toBe(true);
  }
  const snapshot = await (await ownerFetch(`${server.url}/identity/v1/sessions`)).json();
  expect(snapshot.active).toHaveLength(1);
  expect(snapshot.events.find((event: { type: string }) => event.type === (reason === 'heap' ? 'memory_rejected' : 'client_quota'))?.count).toBe(50);
});
