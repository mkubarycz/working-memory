import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadKinds } from '../src/kinds/loader';
import { openStore, type Store } from '../src/store';
import { EMBEDDING_MODEL, semanticStatusSchema, embeddingDashboardSchema } from '../src/embeddingContract';
import { embeddingStats, nextEmbeddingWork, submitEmbeddings } from '../src/topicEmbeddings';
import { InstanceFeatureStore } from '../src/instanceFeatures';
import { EmbeddingIndexer } from '../src/embeddingIndexer';
import { ControlPlaneClient, startServer } from '../../tests/authenticatedFixture';
import { LocalEmbeddings } from '../../desktop-ui/src/main/localEmbeddings';
import { Observability } from '../src/observability';

const stores: Store[] = [];
const hosts: Server[] = [];
const directories: string[] = [];
beforeAll(async () => { await loadKinds(); });
afterEach(async () => {
  for (const host of hosts.splice(0)) {
    host.closeAllConnections();
    await new Promise<void>(resolve => host.close(() => resolve()));
  }
  stores.splice(0).forEach(store => store.close());
  directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true }));
});
async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Background indexing did not meet its expected state.');
}
async function hostFixture(responseDelayMs = 0) {
  let release: (() => void) | undefined;
  let block = false;
  let started = false;
  let invalid = false;
  let busy = false;
  let requests = 0;
  let errorBody: string | undefined;
  let statusError: string | null = null;
  let statusPhase: 'idle' | 'error' = 'idle';
  let statusCode = 200;
  let blockStatus = false;
  let statusStarted = false;
  let releaseStatus: (() => void) | undefined;
  const token = 'c'.repeat(64);
  const host = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    if (req.url === '/status') {
      const answer = () => {
        res.writeHead(statusCode);
        res.end(JSON.stringify({ model: EMBEDDING_MODEL, version: 'test', phase: statusPhase, downloadBytes: 0,
          backend: 'Test accelerator', warning: null, error: statusError, rssBytes: 1000 }));
      };
      if (blockStatus) { statusStarted = true; releaseStatus = answer; }
      else answer();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests++;
      if (busy) { busy = false; res.writeHead(409); res.end('{}'); return; }
      started = true;
      if (errorBody !== undefined) { res.writeHead(500); res.end(errorBody); return; }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      const answer = () => res.end(JSON.stringify({ id: 1, durationMs: 10, startupMs: 12, rssBytes: 1000,
        vectors: input.texts.map(() => Array.from({ length: 384 }, (_, index) => invalid ? 0 : Number(index === 0))) }));
      if (block) release = answer;
      else if (responseDelayMs) setTimeout(answer, responseDelayMs);
      else answer();
    });
  });
  await new Promise<void>(resolve => host.listen(0, '127.0.0.1', resolve));
  hosts.push(host);
  const address = host.address();
  if (!address || typeof address === 'string') throw new Error('Missing host address');
  return { host: { endpoint: `http://127.0.0.1:${address.port}`, token },
    block: () => { block = true; }, started: () => started, release: () => release?.(),
    unblock: () => { block = false; }, invalidate: () => { invalid = true; },
    requests: () => requests, busyOnce: () => { busy = true; },
    fail: (body: string) => { errorBody = body; },
    statusError: (message: string | null) => { statusError = message; statusPhase = 'error'; },
    statusCode: (code: number) => { statusCode = code; },
    blockStatus: () => { blockStatus = true; }, statusStarted: () => statusStarted,
    releaseStatus: () => { blockStatus = false; const answer = releaseStatus; releaseStatus = undefined; answer?.(); } };
}
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wm-background-index-'));
  directories.push(directory);
  const path = join(directory, 'journal.sqlite');
  const store = openStore(path);
  stores.push(store);
  new InstanceFeatureStore(store.db).write({ search: true });
  return { store, path };
}
describe('container-owned embedding lifecycle', () => {
  it('exports indexing/search outcomes and samples paused embeddings without a desktop, excluding private data', async () => {
    const { store } = fixture();
    store.createDocument({ kind: 'Topic', spec: { title: 'Private topic title', body: 'Private document passage.' } });
    const inference = await hostFixture();
    const send = vi.fn<typeof fetch>(async () => Response.json({ code: 200, status: [{ failed: 0 }] }));
    const exporter = new Observability(store.db, () => true, { fetch: send, intervalMs: 60000 });
    const indexer = new EmbeddingIndexer(store.db, () => true, exporter);
    const sample = vi.spyOn(exporter, 'recordEmbeddingSnapshot');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await exporter.configure({ endpoint: 'http://collector:5080', uiUrl: 'http://localhost:5080',
        username: 'test@localhost.invalid', password: 'collector-private-password', claimId: '00000000-0000-4000-8000-000000000001' });
      await indexer.configure({ action: 'enable', host: inference.host });
      await exporter.flush();
      indexer.start();
      await waitFor(() => embeddingStats(store.db).pending === 0);
      expect(await indexer.search({ queries: ['Private search query'] }, () => true)).toMatchObject({ count: 1 });
      await expect(indexer.search({ queries: [] }, () => true)).rejects.toThrow();
      await indexer.configure({ action: 'pause' });
      await vi.advanceTimersByTimeAsync(10000);
      await waitFor(() => sample.mock.calls.some(([state]) => state.phase === 'paused'));
      await exporter.flush();
      const calls = send.mock.calls.filter(([url]) => String(url).includes('/ingest/metrics/'));
      const rows = JSON.parse(String(calls.at(-1)![1]?.body));
      expect(rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ __name__: 'wm_embeddings_indexed_documents', value: 1 }),
        expect.objectContaining({ __name__: 'wm_embeddings_pending_documents', value: 0 }),
        expect.objectContaining({ __name__: 'wm_embeddings_phase', phase: 'paused', value: 1 }),
        expect.objectContaining({ __name__: 'wm_embeddings_operations_total', operation: 'index', outcome: 'completed', value: 1 }),
        expect.objectContaining({ __name__: 'wm_embeddings_operations_total', operation: 'search', outcome: 'completed', value: 1 }),
        expect.objectContaining({ __name__: 'wm_embeddings_operations_total', operation: 'search', outcome: 'failed', value: 1 }),
        expect.objectContaining({ __name__: 'wm_embeddings_stage_duration_seconds_sum', operation: 'search', stage: 'inference', value: 0.01 }),
      ]));
      const exported = send.mock.calls.filter(([url]) => String(url).includes('/api/')).map(([, init]) => String(init?.body)).join('\n');
      for (const privateValue of ['Private topic title', 'Private document passage.', 'Private search query', inference.host.token, inference.host.endpoint]) {
        expect(exported).not.toContain(privateValue);
      }
    } finally {
      await indexer.stop();
      await exporter.close();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('does not poll the embedding host for telemetry when observability is off', async () => {
    const { store } = fixture();
    const inference = await hostFixture();
    const exporter = new Observability(store.db, () => false);
    const indexer = new EmbeddingIndexer(store.db, () => true, exporter);
    store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, ?)').run(JSON.stringify(inference.host));
    const fetches = vi.spyOn(globalThis, 'fetch');
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      indexer.start();
      await vi.advanceTimersByTimeAsync(10000);
      expect(fetches).not.toHaveBeenCalled();
    } finally {
      await indexer.stop();
      await exporter.close();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it.each((['discovery', 'probe'] as const).flatMap(stage =>
    (['pause', 'disable', 'reconfigure'] as const).map(action => ({ stage, action }))))
    ('preserves a second client $action while automatic route $stage is pending', async ({ stage, action }) => {
      const { store } = fixture();
      const old = await hostFixture();
      const replacement = await hostFixture();
      const server = await startServer({ port: 0, store });
      const first = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
      const second = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
      let release!: () => void;
      let started!: () => void;
      const discovering = new Promise<void>(resolve => { started = resolve; });
      const local = new LocalEmbeddings(() => ({ endpoint: `${server.url}/mcp`, client: first }), {
        ensure: async () => {
          started();
          if (stage === 'discovery') await new Promise<void>(resolve => { release = resolve; });
          return replacement.host;
        },
        restore: async () => {},
        readSettings: () => ({ idleTimeoutMinutes: null }),
        setRetention: async minutes => ({ idleTimeoutMinutes: minutes }),
        usesWslNetworking: () => true,
      });
      try {
        expect(await first.callTool('wm-embeddings-configure', { action: 'enable', host: old.host })).toMatchObject({ ok: true });
        old.statusCode(401);
        if (stage === 'probe') replacement.blockStatus();
        const pending = local.snapshot();
        if (stage === 'discovery') await discovering;
        else await waitFor(() => replacement.statusStarted());
        const peerHost = { ...old.host, candidates: [replacement.host.endpoint] };
        if (action === 'reconfigure') old.statusCode(200);
        expect(await second.callTool('wm-embeddings-configure', action === 'reconfigure'
          ? { action: 'retry', host: peerHost } : { action })).toMatchObject({ ok: true });
        if (stage === 'discovery') release();
        else replacement.releaseStatus();
        const result = await pending;
        expect(result).toMatchObject({ enabled: action !== 'disable', paused: action === 'pause' });
        const current = await second.callTool('wm-embeddings-dashboard', {});
        expect(current).toMatchObject({ ok: true, result: {
          enabled: action !== 'disable', paused: action === 'pause', endpoint: old.host.endpoint,
        } });
        const row = store.db.prepare('SELECT host FROM instance_embedding_settings WHERE singleton=1').get();
        expect(JSON.parse(String(row?.host))).toEqual(action === 'reconfigure' ? peerHost : old.host);
      } finally {
        release?.(); replacement.releaseStatus();
        await first.dispose(); await second.dispose(); await server.close();
      }
    });
  it('keeps legacy responses strict-compatible and conditionally repairs an unchanged configuration', async () => {
    const { store } = fixture();
    const old = await hostFixture();
    const replacement = await hostFixture();
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      await client.callTool('wm-embeddings-configure', { action: 'enable', host: old.host });
      const legacy = await client.callTool('wm-embeddings-dashboard', {});
      if (!legacy.ok) throw new Error(legacy.error);
      expect(legacy.result).not.toHaveProperty('configurationKey');
      embeddingDashboardSchema.omit({ configurationKey: true }).parse(legacy.result);
      const optedIn = await client.callTool('wm-embeddings-dashboard', { withConfiguration: true });
      if (!optedIn.ok) throw new Error(optedIn.error);
      const expectedConfiguration = embeddingDashboardSchema.parse(optedIn.result).configurationKey;
      expect(expectedConfiguration).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(optedIn.result)).not.toContain(old.host.token);
      expect(await client.callTool('wm-embeddings-configure', { action: 'retry',
        host: replacement.host, expectedConfiguration })).toMatchObject({
        ok: true, result: { enabled: true, paused: false, endpoint: replacement.host.endpoint },
      });
      const invalid = await client.callTool('wm-embeddings-configure', { action: 'disable', expectedConfiguration });
      expect(invalid.ok).toBe(false);
      expect(JSON.stringify(invalid)).toContain('Conditional route repair requires retry and a host');
      const after = await client.callTool('wm-embeddings-dashboard', {});
      expect(after.ok && after.result).not.toHaveProperty('configurationKey');
    } finally { await client.dispose(); await server.close(); }
  });
  it('chooses a verified secondary endpoint through MCP instead of persisting the first discovered address', async () => {
    const { store } = fixture();
    const bad = await hostFixture(); bad.statusCode(401);
    const good = await hostFixture();
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      expect(await client.callTool('wm-embeddings-configure', {
        action: 'enable', host: { ...bad.host, candidates: [good.host.endpoint] },
      })).toMatchObject({ ok: true, result: { enabled: true, endpoint: good.host.endpoint } });
      new InstanceFeatureStore(store.db).write({ search: false });
      good.statusCode(401);
      expect(await client.callTool('wm-embeddings-dashboard', {})).toMatchObject({
        ok: true, result: { phase: 'paused', error: expect.stringContaining('HTTP 401') },
      });
    } finally { await client.dispose(); await server.close(); }
  });
  it('does not undo a newer Pause while a supplied endpoint probe is pending', async () => {
    const { store } = fixture();
    const indexer = new EmbeddingIndexer(store.db, () => true);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return new Response(JSON.stringify({ model: EMBEDDING_MODEL, version: 'test', phase: 'idle',
        downloadBytes: 0, backend: null, warning: null, error: null, rssBytes: null }));
    });
    try {
      const pending = indexer.configure({ action: 'enable', host: { endpoint: 'http://127.0.0.1:7716', token: 'c'.repeat(64) } });
      await ready;
      await indexer.configure({ action: 'pause' });
      release();
      await expect(pending).rejects.toThrow('superseded');
      expect(await indexer.snapshot()).toMatchObject({ enabled: false, paused: true, endpoint: null });
    } finally { fetch.mockRestore(); indexer.stop(); }
  });
  it('rejects an unreachable supplied endpoint through MCP before persisting or enabling indexing', async () => {
    const { store } = fixture();
    const inference = await hostFixture();
    inference.statusCode(401);
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      const result = await client.callTool('wm-embeddings-configure', { action: 'enable', host: inference.host });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).toContain('The container cannot reach');
      expect(JSON.stringify(result)).toContain('HTTP 401');
      expect(JSON.stringify(result)).not.toContain(inference.host.token);
      const dashboard = await client.callTool('wm-embeddings-dashboard', {});
      expect(dashboard).toMatchObject({ ok: true, result: { enabled: false, endpoint: null } });
      expect(inference.requests()).toBe(0);
    } finally { await client.dispose(); await server.close(); }
  });
  it('preserves inference error details through authenticated MCP and prefers the host root cause', async () => {
    const { store } = fixture();
    store.createDocument({ kind: 'Topic', spec: { title: 'Search troubleshooting', body: 'Private document passage.' } });
    const inference = await hostFixture();
    inference.fail(JSON.stringify({ error: `Bundled helper DLL missing. Bearer ${inference.host.token}` }));
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    const snapshot = async () => {
      const result = await client.callTool('wm-embeddings-dashboard', {});
      expect(JSON.stringify(result)).not.toContain(inference.host.token);
      expect(JSON.stringify(result)).not.toContain('Private document passage.');
      return result.ok ? result.result : null;
    };
    try {
      await client.callTool('wm-embeddings-configure', { action: 'enable', host: inference.host });
      await expect.poll(snapshot).toMatchObject({ phase: 'error', error: expect.stringContaining('Bundled helper DLL missing') });
      inference.statusError('OpenVINO NPU plugin unavailable');
      expect(await snapshot()).toMatchObject({ phase: 'error', error: 'OpenVINO NPU plugin unavailable' });
      inference.statusError(null);
      expect(await snapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('without details') });
      inference.statusCode(401);
      expect(await snapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('HTTP 401') });
    } finally { await client.dispose(); await server.close(); }
  });
  it.each(['not json', '{}', JSON.stringify({ error: 'x'.repeat(9000) })])
    ('reports unreadable or oversized inference error responses explicitly', async body => {
      const { store } = fixture();
      store.createDocument({ kind: 'Topic', spec: { title: 'Search troubleshooting' } });
      const inference = await hostFixture();
      inference.fail(body);
      const server = await startServer({ port: 0, store });
      const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
      try {
        await client.callTool('wm-embeddings-configure', { action: 'enable', host: inference.host });
        await expect.poll(async () => {
          const result = await client.callTool('wm-embeddings-dashboard', {});
          return result.ok ? result.result : null;
        }).toMatchObject({ phase: 'error', error: expect.stringContaining('Error details unavailable') });
      } finally { await client.dispose(); await server.close(); }
    });
  it('allows cold inference beyond thirty seconds through authenticated MCP', async () => {
    const { store } = fixture();
    const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Nanites', body: 'Nanite model research.' } });
    const work = nextEmbeddingWork(store.db).work!;
    submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion, contentHash: work.contentHash,
      model: EMBEDDING_MODEL, vectors: work.passages.map(() => Array.from({ length: 384 }, (_, index) => Number(index === 0))) });
    const inference = await hostFixture(35000);
    new EmbeddingIndexer(store.db, () => true);
    store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, ?)').run(JSON.stringify(inference.host));
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      expect(await client.callTool('wm-semantic-search', { queries: ['nanites'], literalQuery: 'nanites' }))
        .toMatchObject({ ok: true, result: { count: 1, results: [{ id: topic.metadata.id, literalMatch: true }] } });
      expect(inference.requests()).toBe(1);
    } finally { await client.dispose(); await server.close(); }
  }, 45000);

  it.each([35000, 65000])('bounds cold query inference with a useful error (%s ms host response)', async duration => {
    const { store } = fixture();
    store.createDocument({ kind: 'Topic', spec: { title: 'Nanites', body: 'Nanite model research.' } });
    const work = nextEmbeddingWork(store.db).work!;
    const vector = Array.from({ length: 384 }, (_, index) => Number(index === 0));
    submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion, contentHash: work.contentHash,
      model: EMBEDDING_MODEL, vectors: work.passages.map(() => vector) });
    const indexer = new EmbeddingIndexer(store.db, () => true);
    store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, ?)').run(JSON.stringify({
      endpoint: 'http://127.0.0.1:7716', token: 'c'.repeat(64),
    }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>((_url, init) => new Promise((resolve, reject) => {
      const signal = init!.signal!;
      const aborted = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', aborted);
        resolve(new Response(JSON.stringify({ id: 1, durationMs: 10, rssBytes: 1000, vectors: [vector] })));
      }, duration);
      signal.addEventListener('abort', aborted, { once: true });
    })));
    try {
      const pending = indexer.search({ queries: ['nanites'] }, () => true)
        .then(result => ({ result, error: undefined }), error => ({ result: undefined, error }));
      await vi.advanceTimersByTimeAsync(duration);
      const outcome = await pending;
      expect(timeout).toHaveBeenCalledWith(60000);
      if (duration === 35000) expect(outcome.result).toMatchObject({ count: 1 });
      else expect(outcome.error).toMatchObject({ message: expect.stringContaining('starting the local embedding model') });
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
  });

  it('gates authenticated semantic Search, retries busy inference and rejects edits during query inference', async () => {
    const { store } = fixture();
    const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Unreachable service', body: 'Restore network connectivity.' } });
    const inference = await hostFixture();
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    const search = (signal?: AbortSignal) => client.callTool('wm-semantic-search', { queries: ['Fix connection trouble'] }, signal);
    try {
      expect(await search()).toMatchObject({ ok: false, error: expect.stringContaining('Enable Embeddings') });
      expect(inference.requests()).toBe(0);
      inference.block();
      await client.callTool('wm-embeddings-configure', { action: 'enable', host: inference.host });
      await waitFor(inference.started);
      expect(await search()).toMatchObject({
        ok: false,
        error: expect.stringMatching(/Indexing must finish.*Observability; enable Observability in Settings > Features/),
      });
      expect(inference.requests()).toBe(1);
      inference.release(); inference.unblock();
      await waitFor(() => embeddingStats(store.db).pending === 0);
      await client.callTool('wm-embeddings-configure', { action: 'pause' });
      const status = await client.callTool('wm-semantic-status', {});
      if (!status.ok) throw new Error(status.error);
      expect(semanticStatusSchema.parse(status.result)).toMatchObject({ enabled: true, ready: true, stats: { indexed: 1 } });
      inference.busyOnce();
      const before = inference.requests();
      expect(await search()).toMatchObject({ ok: true, result: { count: 1,
        timings: { startupMs: 12, inferenceMs: 10, hostMs: expect.any(Number), rankingMs: expect.any(Number) },
        results: [{ id: topic.metadata.id, kind: 'Topic', similarity: 1, excerpt: expect.stringContaining('connectivity') }] } });
      expect(inference.requests()).toBe(before + 2);
      expect(await client.callTool('wm-semantic-search', {
        queries: ['connectivity'], literalQuery: 'connectivity', kinds: ['Topic'], limit: 1,
      })).toMatchObject({ ok: true, result: { count: 1,
        results: [{ id: topic.metadata.id, kind: 'Topic', literalMatch: true, confidence: { level: 'high' } }] } });
      inference.block();
      const beforeEdit = inference.requests();
      const pending = search();
      await waitFor(() => inference.requests() > beforeEdit);
      const current = store.getDocument({ id: topic.metadata.id })!;
      store.updateDocument({ id: current.metadata.id, expectedResourceVersion: current.metadata.resourceVersion,
        spec: { ...current.spec, body: 'Edited while query inference is running.' } });
      inference.release(); inference.unblock();
      expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('Indexing must finish') });
      const work = nextEmbeddingWork(store.db).work!;
      submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion, contentHash: work.contentHash,
        model: EMBEDDING_MODEL, vectors: work.passages.map(() => Array.from({ length: 384 }, (_, index) => Number(index === 0))) });
      inference.block();
      const controller = new AbortController();
      const requests = inference.requests();
      const cancelled = search(controller.signal);
      await waitFor(() => inference.requests() > requests);
      controller.abort(new Error('Search cancelled'));
      expect(await cancelled).toMatchObject({ ok: false, error: expect.stringContaining('Search cancelled') });
      inference.release(); inference.unblock();
      inference.invalidate();
      expect(await search()).toMatchObject({ ok: false });
      new InstanceFeatureStore(store.db).write({ search: false });
      expect(await search()).toMatchObject({ ok: false, error: expect.stringContaining('Search is turned off') });
    } finally { await client.dispose(); await server.close(); }
  });

  it('returns a genuine empty search for a complete empty corpus without inference', async () => {
    const { store } = fixture();
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      expect(await client.callTool('wm-semantic-search', { queries: ['Anything'] }))
        .toMatchObject({ ok: true, result: { count: 0, results: [], limited: false } });
    } finally { await client.dispose(); await server.close(); }
  });

  it('continues after the desktop client disconnects and resumes enabled indexing after container restart', async () => {
    const { store, path } = fixture();
    store.createDocument({ kind: 'Topic', spec: { title: 'Network recovery' } });
    const inference = await hostFixture();
    inference.block();
    let server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      expect((await client.callTool('wm-embeddings-configure', { action: 'enable', host: inference.host })).ok).toBe(true);
      await waitFor(inference.started);
      await client.dispose();
      inference.release();
      await waitFor(() => embeddingStats(store.db).indexed === 1);
      await server.close();
      store.close();
      stores.splice(stores.indexOf(store), 1);
      const restarted = openStore(path);
      stores.push(restarted);
      inference.unblock();
      restarted.createDocument({ kind: 'Topic', spec: { title: 'Unreachable server' } });
      server = await startServer({ port: 0, store: restarted });
      await waitFor(() => embeddingStats(restarted.db).indexed === 2);
    } finally { await client.dispose(); await server.close(); }
  });
  it('cancels in-flight indexing on pause without changing authored topic content', async () => {
    const { store } = fixture();
    const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Network recovery' } });
    const inference = await hostFixture();
    inference.block();
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      await client.callTool('wm-embeddings-configure', { action: 'enable', host: inference.host });
      await waitFor(inference.started);
      expect((await client.callTool('wm-embeddings-configure', { action: 'pause' })).ok).toBe(true);
      inference.release();
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(embeddingStats(store.db).indexed).toBe(0);
      expect(store.getDocument({ id: topic.metadata.id })).toEqual(topic);
      const snapshot = await client.callTool('wm-embeddings-dashboard', {});
      expect(snapshot.ok && snapshot.result).toMatchObject({ paused: true, phase: 'paused' });
      expect(JSON.stringify(snapshot)).not.toContain(inference.host.token);
    } finally { await client.dispose(); await server.close(); }
  });
  it('rejects remote inference targets and exposes malformed vector failures', async () => {
    const { store } = fixture();
    store.createDocument({ kind: 'Topic', spec: { title: 'Network recovery' } });
    const inference = await hostFixture();
    inference.invalidate();
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      expect((await client.callTool('wm-embeddings-configure', { action: 'enable',
        host: { ...inference.host, endpoint: 'http://example.test:7716' } })).ok).toBe(false);
      await client.callTool('wm-embeddings-configure', { action: 'enable', host: inference.host });
      await waitFor(inference.started);
      await new Promise(resolve => setTimeout(resolve, 100));
      const snapshot = await client.callTool('wm-embeddings-dashboard', {});
      expect(snapshot.ok && snapshot.result).toMatchObject({ phase: 'error', error: expect.stringContaining('invalid vectors') });
      expect(embeddingStats(store.db).indexed).toBe(0);
    } finally { await client.dispose(); await server.close(); }
  });
});
