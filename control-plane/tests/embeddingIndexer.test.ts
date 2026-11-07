import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadKinds } from '../src/kinds/loader';
import { openStore, type Store } from '../src/store';
import { EMBEDDING_MODEL, semanticStatusSchema } from '../src/embeddingContract';
import { embeddingStats, nextEmbeddingWork, submitEmbeddings } from '../src/topicEmbeddings';
import { InstanceFeatureStore } from '../src/instanceFeatures';
import { EmbeddingIndexer } from '../src/embeddingIndexer';
import { ControlPlaneClient, startServer } from '../../tests/authenticatedFixture';

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
  const token = 'c'.repeat(64);
  const host = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    expect(req.headers.authorization).toBe(`Bearer ${token}`);
    if (req.url === '/status') {
      res.end(JSON.stringify({ model: EMBEDDING_MODEL, version: 'test', phase: 'idle', downloadBytes: 0,
        backend: 'Test accelerator', warning: null, error: null, rssBytes: 1000 }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests++;
      if (busy) { busy = false; res.writeHead(409); res.end('{}'); return; }
      started = true;
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
    requests: () => requests, busyOnce: () => { busy = true; } };
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
      expect(await search()).toMatchObject({ ok: false, error: expect.stringContaining('Indexing must finish') });
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
