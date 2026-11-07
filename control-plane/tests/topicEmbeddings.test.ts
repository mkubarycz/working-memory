import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadKinds } from '../src/kinds/loader';
import { openStore, type Store } from '../src/store';
import { EMBEDDING_KINDS, EMBEDDING_MODEL, embeddingBatchSchema, matchConfidence } from '../src/embeddingContract';
import { embeddingStats, nextEmbeddingWork, relatedTopics, semanticSearch, submitEmbeddings } from '../src/topicEmbeddings';
import { getKind } from '../src/kinds/registry';
import { ControlPlaneClient, startServer } from '../../tests/authenticatedFixture';
import { InstanceFeatureStore } from '../src/instanceFeatures';
import { instanceToolPermissions } from '../src/instanceAuthorization';

const stores: Store[] = [];
beforeAll(async () => { await loadKinds(); });
afterEach(() => { vi.restoreAllMocks(); stores.splice(0).forEach(store => store.close()); });
function fixture() { const store = openStore(':memory:'); stores.push(store); return store; }
const unit = (index = 0) => Array.from({ length: 384 }, (_, i) => Number(i === index));
function submit(store: Store, direction = 0) {
  const work = nextEmbeddingWork(store.db).work!;
  return submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion,
    contentHash: work.contentHash, model: EMBEDDING_MODEL, vectors: work.passages.map(() => unit(direction)) });
}

describe('topic embeddings', () => {
  it.each([
    ['BANK account', 'bank', true],
    ['Banking services', 'bank', false],
    ['bank_ledger', 'bank', false],
    ['A bank account', 'bank account', true],
    ['A "bank" account', '"bank"', true],
    ['CAF\u00c9 details', 'caf\u00e9', true],
    ['---', '---', false],
  ] as const)('verifies literal boundaries and escaped FTS phrases in %s', (body, literalQuery, matches) => {
    const store = fixture();
    store.createDocument({ kind: 'Topic', spec: { title: 'Notes', body } });
    submit(store);
    const result = semanticSearch(store.db, { queries: [literalQuery], literalQuery, limit: 1 }, [unit().map(value => -value)], () => true);
    expect(result.results.length).toBe(matches ? 1 : 0);
    if (matches) expect(result.results[0]).toMatchObject({ literalMatch: true, similarity: -1, confidence: { level: 'high' } });
  });

  it('returns exact whole-word matches before higher semantic scores, including matches beyond semantic coverage', () => {
    const store = fixture();
    const exact = store.createDocument({ kind: 'Topic', spec: { title: 'Account notes', body: 'My BANK account details.' } });
    submit(store, 1);
    const semantic = store.createDocument({ kind: 'Topic', spec: { title: 'Finance', body: 'Banking services and investments.' } });
    submit(store);
    const later = store.createDocument({ kind: 'Topic', spec: { title: 'Long notes', body: `${'A'.repeat(33000)} bank notes` } });
    submit(store, 1);
    const input = { queries: ['bank'], literalQuery: 'bank', limit: 40 };
    const result = semanticSearch(store.db, input, [unit()], () => true);
    expect(result.results.slice(0, 2).map(hit => hit.id).sort()).toEqual([exact.metadata.id, later.metadata.id].sort());
    expect(result.results.slice(0, 2).every(hit => hit.literalMatch && hit.similarity === 0 && hit.confidence?.level === 'high')).toBe(true);
    expect(result.results[2]).toMatchObject({ id: semantic.metadata.id, similarity: 1 });
    expect(result.results[2].literalMatch).toBeUndefined();
    expect(result.results.find(hit => hit.id === later.metadata.id)?.excerpt).toContain('bank notes');
    expect(semanticSearch(store.db, { ...input, limit: 1 }, [unit()], () => true).results[0].literalMatch).toBe(true);
    expect(semanticSearch(store.db, input, [unit()], () => false).results).toEqual([]);
    expect(relatedTopics(store.db, { id: exact.metadata.id }, true).results[0].confidence?.level).toBe('medium');
  });

  it.each([
    [0.65, 0.5, false, false, 'high'],
    [0.65, 0.5, false, true, 'medium'],
    [0.45, 0.35, false, false, 'medium'],
    [0.8, 0.1, false, false, 'low'],
    [0.44, 0.8, false, false, 'low'],
    [0, 0, true, false, 'high'],
  ] as const)('uses the same evidence rubric for passage=%s document=%s literal=%s limited=%s', (passage, document, literal, limited, level) => {
    expect(matchConfidence(passage, document, literal, limited)).toMatchObject({ level, reason: expect.any(String) });
  });

  it('indexes safe projected WM kinds, never Config, journal internals or arbitrary spec fields', () => {
    const store = fixture();
    const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Unicode 😀 title', body: 'Authored topic text' } });
    const agent = store.createDocument({ kind: 'Agent', spec: { name: 'Embedding test caller' } });
    store.createDocument({ kind: 'Workstream', spec: { title: 'Release plan', closure: 'Planned improvements' } });
    store.createDocument({ kind: 'TopicType', spec: { label: 'Case', icon: 'notebook', description: 'Case description', body_template: 'Not searchable template' } });
    store.createDocument({ kind: 'ContainerClaim', spec: { title: 'Application registration', repository: 'owner/repo' } });
    store.createDocument({ kind: 'AgentMessage', spec: { agent_id: agent.metadata.id, category: 'completion',
      title: 'Delivery information', description: 'Authored message text', topics: [topic.metadata.id] } });
    const journal = store.createDocument({ kind: 'CommandJournal', spec: {
      schemaVersion: 2, status: 'succeeded', startedAt: 1, completedAt: 2,
      provider: { endpoint: 'http://127.0.0.1:1234', mode: 'chat-completions', model: 'test' },
      request: { userText: 'Authored journal request' }, primaryScope: { kind: 'Topic', id: topic.metadata.id }, entityRefs: [],
      events: [{ id: 'turn', sequence: 1, timestamp: 1, type: 'model_turn', role: 'assistant',
        iteration: 1, assistantText: 'Not searchable intermediate reasoning', durationMs: 1 }],
      completion: { finalAssistantText: 'Authored final answer', stopReason: 'complete', mutated: false },
    } });
    const secret = store.createDocument({ kind: 'Config', spec: { name: 'Private configuration', data: { password: 'Never embed this value' } } });
    const projection = vi.spyOn(getKind('CommandJournal')!.descriptor, 'fts');
    const passages: string[] = [];
    for (let index = 0; index < EMBEDDING_KINDS.length; index++) {
      const work = nextEmbeddingWork(store.db).work!;
      passages.push(...work.passages);
      if (work.id === topic.metadata.id) expect(work.passages).toEqual(['Unicode 😀 title\nAuthored topic text']);
      submit(store);
    }
    expect(nextEmbeddingWork(store.db).work).toBeNull();
    expect(embeddingStats(store.db)).toMatchObject({ total: 7, indexed: 7, pending: 0 });
    expect(projection).not.toHaveBeenCalled();
    for (const excluded of ['Never embed this value', 'Not searchable template', 'Not searchable intermediate reasoning']) {
      expect(passages.join('\n')).not.toContain(excluded);
    }
    expect(passages.join('\n')).toContain('Authored final answer');
    const results = semanticSearch(store.db, { queries: ['meaning'], limit: 40 }, [unit()], () => true).results;
    expect(results.map(hit => hit.kind).sort()).toEqual([...EMBEDDING_KINDS].sort());
    expect(results.find(hit => hit.id === journal.metadata.id)?.excerpt).toContain('Authored journal request');
    expect(semanticSearch(store.db, { queries: ['meaning'], limit: 1 }, [unit()], kind => kind === 'Topic').results)
      .toMatchObject([{ id: topic.metadata.id, similarity: 1 }]);
    expect(semanticSearch(store.db, { queries: ['meaning'], kinds: ['Agent'] }, [unit()], () => true).results)
      .toMatchObject([{ id: agent.metadata.id }]);
    expect(semanticSearch(store.db, { queries: ['meaning'] }, [unit()], () => false).results).toEqual([]);
    expect(() => semanticSearch(store.db, { queries: ['meaning'], kinds: ['Config'] }, [unit()], () => true)).toThrow();
    expect(relatedTopics(store.db, { id: topic.metadata.id }, true).results).toEqual([]);
    expect(submitEmbeddings(store.db, { id: secret.metadata.id, sourceVersion: secret.metadata.resourceVersion,
      contentHash: 'a'.repeat(64), model: EMBEDDING_MODEL, vectors: [unit()] })).toEqual({ accepted: false });
  });

  it('matches supporting passages without losing them in a long-document centroid and excludes stale/deleted evidence', () => {
    const store = fixture();
    const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Multiple subjects', body: 'A'.repeat(5000) } });
    const work = nextEmbeddingWork(store.db).work!;
    submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion, contentHash: work.contentHash,
      model: EMBEDDING_MODEL, vectors: work.passages.map((_, index) => unit(index === 0 ? 0 : 1)) });
    const search = () => semanticSearch(store.db, { queries: ['first subject'] }, [unit()], () => true);
    expect(search().results).toMatchObject([{ id: topic.metadata.id, similarity: 1 }]);
    const current = store.getDocument({ id: topic.metadata.id })!;
    store.updateDocument({ id: current.metadata.id, expectedResourceVersion: current.metadata.resourceVersion,
      spec: { ...current.spec, body: 'Changed content' } });
    expect(search().results).toEqual([]);
    submit(store);
    expect(search().results).toHaveLength(1);
    store.deleteDocument({ id: topic.metadata.id });
    expect(search().results).toEqual([]);
  });

  it('persists normalized vectors without changing authored documents and finds meaning matches', () => {
    const store = fixture();
    const original = store.createDocument({ kind: 'Topic', spec: { title: 'Connection trouble', body: 'A private network route keeps failing.' } });
    submit(store);
    const related = store.createDocument({ kind: 'Topic', spec: { title: 'Unreachable service', body: 'Packets cannot reach the server.' } });
    submit(store);
    store.createDocument({ kind: 'Topic', spec: { title: 'Sourdough', body: 'Baking bread.' } });
    submit(store, 1);
    expect(store.getDocument({ id: original.metadata.id })).toEqual(original);
    const result = relatedTopics(store.db, { id: original.metadata.id }, true);
    expect(result.state).toBe('ready');
    expect(result.results.map(hit => hit.id)).toEqual([related.metadata.id]);
    expect(result.results[0].excerpt).toContain('Packets');
    expect(embeddingStats(store.db)).toMatchObject({ total: 3, indexed: 3, pending: 0, vectorBytes: 3 * 384 * 4 });
  });

  it('does not query topics or cached vectors when Embeddings is disabled', () => {
    const store = fixture();
    const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Cached topic' } });
    submit(store);
    const prepare = vi.spyOn(store.db, 'prepare');
    expect(relatedTopics(store.db, { id: topic.metadata.id }, false))
      .toEqual({ state: 'disabled', limited: false, results: [] });
    expect(prepare).not.toHaveBeenCalled();
  });

  it('excludes keyword-only matches and ranks only indexed semantic matches', () => {
    const store = fixture();
    const source = store.createDocument({ kind: 'Topic', spec: { title: 'Network recovery' } });
    submit(store);
    store.createDocument({ kind: 'Topic', spec: { title: 'Network recovery configuration' } });
    submit(store, 1);
    const match = store.createDocument({ kind: 'Topic', spec: { title: 'Restore connectivity' } });
    submit(store);
    store.createDocument({ kind: 'Topic', spec: { title: 'Network recovery not indexed' } });
    const result = relatedTopics(store.db, { id: source.metadata.id }, true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ id: match.metadata.id, evidence: 'semantic', similarity: 1 });
  });

  it('rejects stale submissions, reuses metadata-only edits and removes deleted vectors', () => {
    const store = fixture();
    const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Network', body: 'Original content' } });
    const work = nextEmbeddingWork(store.db).work!;
    store.updateDocument({ id: topic.metadata.id, expectedResourceVersion: topic.metadata.resourceVersion, spec: { ...topic.spec, body: 'Changed content' } });
    expect(submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion,
      contentHash: work.contentHash, model: EMBEDDING_MODEL, vectors: work.passages.map(() => unit()) }).accepted).toBe(false);
    submit(store);
    const updated = store.getDocument({ id: topic.metadata.id })!;
    store.updateDocument({ id: updated.metadata.id, expectedResourceVersion: updated.metadata.resourceVersion, spec: { ...updated.spec, status: 'closed' } });
    expect(nextEmbeddingWork(store.db).work).toBeNull();
    expect(embeddingStats(store.db).indexed).toBe(1);
    store.deleteDocument({ id: topic.metadata.id });
    expect(submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion,
      contentHash: work.contentHash, model: EMBEDDING_MODEL, vectors: work.passages.map(() => unit()) })).toEqual({ accepted: false });
    nextEmbeddingWork(store.db);
    expect(store.db.prepare('SELECT count(*) AS count FROM topic_embedding_passages').get()?.count).toBe(0);
  });

  it('does not reuse incompatible model vectors; validates vector and passage counts', () => {
    const store = fixture();
    const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Network', body: 'Content' } });
    submit(store);
    store.db.prepare("UPDATE topic_embedding_index SET model_id = 'old-model'").run();
    const work = nextEmbeddingWork(store.db).work!;
    expect(work.id).toBe(topic.metadata.id);
    const input = { id: work.id, sourceVersion: work.sourceVersion, contentHash: work.contentHash, model: EMBEDDING_MODEL };
    expect(() => submitEmbeddings(store.db, { ...input, vectors: [Array(384).fill(0)] })).toThrow();
    expect(() => submitEmbeddings(store.db, { ...input, vectors: [unit(), unit()] })).toThrow('count');
  });

  it('keeps Unicode passages bounded and explicitly reports long-body coverage', () => {
    const store = fixture();
    store.createDocument({ kind: 'Topic', spec: { title: 'Unicode', body: '😀'.repeat(33000) } });
    const batch = embeddingBatchSchema.parse(nextEmbeddingWork(store.db));
    expect(batch.work?.limited).toBe(true);
    expect(batch.work?.passages.length).toBeLessThanOrEqual(80);
    expect(batch.work?.passages[0]).not.toContain('\uFFFD');
    submit(store);
    expect(embeddingStats(store.db).limited).toBe(1);
  });

  it('distinguishes authored parent links, applies workstream filters and returns no pending substitutes', () => {
    const store = fixture();
    const stream = store.createDocument({ kind: 'Workstream', spec: { title: 'Release' } });
    submit(store);
    const source = store.createDocument({ kind: 'Topic', spec: { title: 'Network recovery', body: 'Restore service.' } });
    submit(store);
    const target = store.createDocument({ kind: 'Topic', spec: { title: 'Network repair', body: 'Repair connectivity.',
      parents: [source.metadata.id], workstreams: [stream.metadata.id] } });
    submit(store);
    expect(relatedTopics(store.db, { id: source.metadata.id, workstream: stream.metadata.id }, true).results[0])
      .toMatchObject({ id: target.metadata.id, alreadyLinked: true, evidence: 'semantic' });
    expect(relatedTopics(store.db, { id: source.metadata.id, workstream: 'missing' }, true).results).toEqual([]);
    const pending = store.createDocument({ kind: 'Topic', spec: { title: 'Network incident' } });
    expect(relatedTopics(store.db, { id: pending.metadata.id }, true))
      .toEqual({ state: 'pending', limited: false, results: [] });
  });

  it('wires the authenticated MCP entry points and gates indexing on Search', async () => {
    const store = fixture();
    store.createDocument({ kind: 'Topic', spec: { title: 'Production API' } });
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      expect((await client.callTool('wm-embeddings-next', {})).ok).toBe(false);
      new InstanceFeatureStore(store.db).write({ search: true });
      const next = await client.callTool('wm-embeddings-next', {});
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error(next.error);
      const work = embeddingBatchSchema.parse(next.result).work!;
      const disabled = await client.callTool('wm-related-topics', { id: work.id });
      expect(disabled.ok).toBe(true);
      if (disabled.ok) expect(disabled.result).toEqual({ state: 'disabled', limited: false, results: [] });
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      const pending = await client.callTool('wm-related-topics', { id: work.id });
      expect(pending.ok).toBe(true);
      if (pending.ok) expect(pending.result).toEqual({ state: 'pending', limited: false, results: [] });
      expect((await client.callTool('wm-embeddings-submit', { id: work.id, sourceVersion: work.sourceVersion,
        contentHash: work.contentHash, model: EMBEDDING_MODEL, vectors: work.passages.map(() => unit()) })).ok).toBe(true);
      const ready = await client.callTool('wm-related-topics', { id: work.id });
      expect(ready.ok).toBe(true);
      if (ready.ok) expect(ready.result).toMatchObject({ state: 'ready' });
      expect((await client.callTool('wm-embeddings-configure', { action: 'disable' })).ok).toBe(true);
      const disabledAgain = await client.callTool('wm-related-topics', { id: work.id });
      expect(disabledAgain.ok).toBe(true);
      if (disabledAgain.ok) expect(disabledAgain.result).toEqual({ state: 'disabled', limited: false, results: [] });
      expect(embeddingStats(store.db).indexed).toBe(1);
      const search = await client.callTool('wm-document-search', { queries: ['Production'], kinds: ['Topic'] });
      expect(search.ok).toBe(true);
      if (search.ok) expect(search.result).toMatchObject({ results: [{ id: work.id }] });
      expect((await client.callTool('wm-embeddings-status', {})).ok).toBe(true);
      expect(instanceToolPermissions('wm-embeddings-submit', {}, store)).toEqual([
        { category: 'content', operation: 'read' }, { category: 'settings', operation: 'update' },
      ]);
    } finally { await client.dispose(); await server.close(); }
  });
});
