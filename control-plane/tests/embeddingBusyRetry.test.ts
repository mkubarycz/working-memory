import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { openStore } from '../src/store';
import { loadKinds } from '../src/kinds/loader';
import { EmbeddingIndexer } from '../src/embeddingIndexer';
import { EMBEDDING_MODEL } from '../src/embeddingContract';
import { nextEmbeddingWork, submitEmbeddings } from '../src/topicEmbeddings';

vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => {}) }));
beforeAll(() => loadKinds());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.mocked(delay).mockReset(); });

function fixture() {
  const store = openStore(':memory:');
  store.createDocument({ kind: 'Topic', spec: { title: 'Nanites' } });
  const work = nextEmbeddingWork(store.db).work!;
  const vector = Array.from({ length: 384 }, (_, index) => Number(index === 0));
  submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion, contentHash: work.contentHash,
    model: EMBEDDING_MODEL, vectors: work.passages.map(() => vector) });
  const indexer = new EmbeddingIndexer(store.db, () => true);
  store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, ?)').run(JSON.stringify({
    endpoint: 'http://127.0.0.1:7716', token: 'c'.repeat(64),
  }));
  const search = (signal?: AbortSignal) => indexer.search({ queries: ['nanites'] }, () => true, signal);
  return { store, vector, search };
}

it('retries contention beyond three seconds with capped backoff, releasing each busy response', async () => {
  const f = fixture(), cancelled: Array<ReturnType<typeof vi.fn>> = [];
  let requests = 0;
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
    if (requests++ < 8) {
      const cancel = vi.fn();
      cancelled.push(cancel);
      return new Response(new ReadableStream({ cancel }), { status: 409 });
    }
    return new Response(JSON.stringify({ id: 1, durationMs: 10, rssBytes: 1000, vectors: [f.vector] }));
  }));
  vi.mocked(delay).mockResolvedValue(undefined);
  try {
    expect(await f.search()).toMatchObject({ count: 1 });
    expect(requests).toBe(9);
    expect(vi.mocked(delay).mock.calls.map(([ms]) => ms)).toEqual([500, 1000, 2000, 2000, 2000, 2000, 2000, 2000]);
    expect(cancelled.every(cancel => cancel.mock.calls.length === 1)).toBe(true);
  } finally { f.store.close(); }
});

it.each(['cancellation', 'deadline'] as const)('stops busy retries on %s instead of imposing an attempt limit', async reason => {
  const f = fixture(), caller = new AbortController(), deadline = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 409 }));
  vi.stubGlobal('fetch', request);
  let attempts = 0;
  vi.mocked(delay).mockImplementation(async (_ms, _value, options) => {
    if (++attempts === 5) {
      if (reason === 'cancellation') caller.abort(new Error('Caller cancelled search'));
      else deadline.abort(new DOMException('Deadline expired', 'TimeoutError'));
    }
    options?.signal?.throwIfAborted();
  });
  try {
    await expect(f.search(caller.signal)).rejects.toThrow(reason === 'cancellation' ? 'Caller cancelled search' : '60 seconds');
    expect(request).toHaveBeenCalledTimes(5);
  } finally { f.store.close(); }
});

it('does not retry non-busy host failures', async () => {
  const f = fixture(), request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 500 }));
  vi.stubGlobal('fetch', request);
  try {
    await expect(f.search()).rejects.toThrow('HTTP 500');
    expect(request).toHaveBeenCalledOnce();
    expect(delay).not.toHaveBeenCalled();
  } finally { f.store.close(); }
});

it('rechecks indexing availability before retrying a busy helper', async () => {
  const f = fixture(), request = vi.fn<typeof fetch>(async () => new Response('{}', { status: 409 }));
  vi.stubGlobal('fetch', request);
  vi.mocked(delay).mockImplementation(async () => {
    f.store.db.prepare('UPDATE instance_embedding_settings SET enabled=0').run();
  });
  try {
    await expect(f.search()).rejects.toThrow('Enable Embeddings');
    expect(request).toHaveBeenCalledOnce();
  } finally { f.store.close(); }
});
