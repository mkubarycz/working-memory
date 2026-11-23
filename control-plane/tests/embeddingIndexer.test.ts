import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadKinds } from '../src/kinds/loader';
import { openStore, type Store } from '../src/store';
import { EMBEDDING_MODEL, semanticStatusSchema, embeddingDashboardSchema, relatedTopicsSchema } from '../src/embeddingContract';
import { embeddingStats, nextEmbeddingWork, submitEmbeddings } from '../src/topicEmbeddings';
import { InstanceFeatureStore } from '../src/instanceFeatures';
import { EmbeddingIndexer } from '../src/embeddingIndexer';
import { ControlPlaneClient, startServer } from '../../tests/authenticatedFixture';
import { LocalEmbeddings } from '../../desktop-ui/src/main/localEmbeddings';
import { Observability } from '../src/observability';
import { isDocumentSearchResult } from '../../shared/documentSearch';
import * as retrieval from '../src/documentSearch';

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
  it.each([
    ['INC-42', false], ['A3', false], ['owner_alpha', false], ['ID', false], ['S', false],
    ['d85dbeef-2abc-4a01-9def-abcdef012345', true],
    ['silver albatross', false], ['marmalade', false], ['20261411192068475308', false], ['undefined', false],
    [`${'X'.repeat(400)}-42`, false],
  ] as const)('shares general lexical/semantic discovery for %s across authenticated Search, Related topics and placement', async (reference, longBody) => {
    const { store } = fixture();
    const email = store.createDocument({ kind: 'Workstream', spec: { title: 'Email' } });
    const destination = store.createDocument({ kind: 'Workstream', spec: { title: 'test' } });
    const authoredReference = reference === 'S' ? '\u017f' : reference;
    const source = store.createDocument({ kind: 'Topic', spec: {
      title: longBody ? 'Email follow-up' : `Re: ${reference}`,
      ...(reference === 'A3' ? {} : { body: `${longBody ? 'A'.repeat(33000) : ''}\n${reference} An email about this reference` }),
      workstreams: [email.metadata.id],
    } });
    const exact = store.createDocument({ kind: 'Topic', spec: {
      title: longBody ? 'Collected notes' : `Tracking ${authoredReference}`,
      body: `${longBody ? 'B'.repeat(33000) : 'The curious kettle collected raindrops in a thimble.'}\n${authoredReference}`,
      workstreams: [destination.metadata.id],
    } });
    const near = store.createDocument({ kind: 'Topic', spec: {
      title: reference === 'ID' ? 'Cafe\u0301-ID' : `${reference}0`,
      ...(reference === 'A3' ? {} : { body: 'A postcard reached Saturn.' }),
      workstreams: [destination.metadata.id],
    } });
    const artifact = store.createDocument({ kind: 'Topic', spec: { title: 'Archive', workstreams: [destination.metadata.id] } });
    const suffixNear = reference === 'ID' ? store.createDocument({ kind: 'Topic',
      spec: { title: 'ID-\u0301Cafe', workstreams: [destination.metadata.id] } }) : null;
    for (let index = 0; index < 65; index++) {
      store.createDocument({ kind: 'Topic', spec: {
        title: `Other example ${index}`, ...(reference === 'undefined' ? {} : { body: 'The orange beetle wrote a postcard to Saturn.' }),
        workstreams: [destination.metadata.id],
      } });
    }
    for (;;) {
      const work = nextEmbeddingWork(store.db).work;
      if (!work) break;
      submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion, contentHash: work.contentHash,
        model: EMBEDDING_MODEL, vectors: work.passages.map(() => Array.from({ length: 384 },
          (_, index) => Number(index === (work.id === exact.metadata.id ? 1 : 0)))) });
    }
    const inference = await hostFixture();
    new EmbeddingIndexer(store.db, () => true);
    store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, ?)').run(JSON.stringify(inference.host));
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      const search = await client.callTool('wm-semantic-search', { queries: [reference], literalQuery: reference, kinds: ['Topic'], limit: 5 });
      if (!search.ok) throw new Error(search.error);
      if (!isDocumentSearchResult(search.result)) throw new Error('Invalid search result');
      expect(search.result.results.slice(0, 3).map(hit => hit.id)).toContain(exact.metadata.id);
      expect(search.result.results.find(hit => hit.id === exact.metadata.id)).toMatchObject({
        similarity: 0, literalMatch: true, resourceVersion: exact.metadata.resourceVersion,
        excerpt: expect.stringContaining(authoredReference), confidence: { reason: expect.stringContaining('Verified lexical evidence') },
      });
      if (!reference.includes(' ')) expect(search.result.results.find(hit => hit.id === near.metadata.id)?.literalMatch).not.toBe(true);
      if (suffixNear) expect(search.result.results.find(hit => hit.id === suffixNear.metadata.id)?.literalMatch).not.toBe(true);
      expect(search.result.results.find(hit => hit.id === artifact.metadata.id)?.literalMatch).not.toBe(true);
      const related = await client.callTool('wm-related-topics', { id: source.metadata.id, limit: 5 });
      if (!related.ok) throw new Error(related.error);
      expect(relatedTopicsSchema.parse(related.result).results.slice(0, 3).map(hit => hit.id)).toContain(exact.metadata.id);
      expect(relatedTopicsSchema.parse(related.result).results.find(hit => hit.id === exact.metadata.id)).toMatchObject({
        similarity: 0, evidence: 'keyword', confidence: { reason: expect.stringContaining('Verified lexical evidence') },
      });
      expect(relatedTopicsSchema.parse(related.result).results.find(hit => hit.id === artifact.metadata.id)?.evidence).not.toBe('keyword');
      expect(relatedTopicsSchema.parse(related.result).results.find(hit => hit.id === artifact.metadata.id)?.evidence).not.toBe('both');
      const placement = await client.topicSuggestPlacement(source.metadata.id);
      expect(placement.suggestions.slice(0, 3).map(suggestion => suggestion.parent?.id)).toContain(exact.metadata.id);
      expect(placement.suggestions.find(suggestion => suggestion.parent?.id === exact.metadata.id)).toMatchObject({
        similarity: 0, workstream: { id: destination.metadata.id }, excerpt: expect.stringContaining(authoredReference),
      });
      expect(placement.suggestions.find(suggestion => suggestion.parent?.id === artifact.metadata.id)?.confidence.reason ?? '')
        .not.toContain('Verified lexical evidence');
      expect(store.getDocument({ id: source.metadata.id })).toEqual(source);
    } finally { await client.dispose(); await server.close(); }
  });

  it.each([2, 60])('suppresses frequent numbers and boilerplate in a %s-distractor corpus while retaining semantic-only discovery', async count => {
    const { store } = fixture();
    const workstream = store.createDocument({ kind: 'Workstream', spec: { title: 'Destination' } });
    const source = store.createDocument({ kind: 'Topic', spec: { title: '2026 Weekly report',
      body: 'Please review the weekly report 2026' } });
    const meaningful = store.createDocument({ kind: 'Topic', spec: { title: 'Restoring connectivity',
      body: 'Packets cannot reach their destination.', workstreams: [workstream.metadata.id] } });
    for (let index = 0; index < count; index++) {
      store.createDocument({ kind: 'Topic', spec: { title: '2026 Weekly report',
        body: 'Please review the weekly report 2026', workstreams: [workstream.metadata.id] } });
    }
    for (;;) {
      const work = nextEmbeddingWork(store.db).work;
      if (!work) break;
      submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion, contentHash: work.contentHash,
        model: EMBEDDING_MODEL, vectors: work.passages.map(() => Array.from({ length: 384 },
          (_, index) => Number(index === ([source.metadata.id, meaningful.metadata.id].includes(work.id) ? 0 : 1)))) });
    }
    const inference = await hostFixture();
    new EmbeddingIndexer(store.db, () => true);
    store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, ?)').run(JSON.stringify(inference.host));
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      const search = await client.callTool('wm-semantic-search', { queries: ['Please review the weekly report 2026'], limit: 5 });
      expect(search).toMatchObject({ ok: true, result: { results: expect.arrayContaining([
        expect.objectContaining({ id: meaningful.metadata.id, similarity: 1 }),
      ]) } });
      if (!search.ok || !isDocumentSearchResult(search.result)) throw new Error('Invalid search response');
      expect(search.result.results.every(hit => !hit.literalMatch)).toBe(true);
      const related = await client.callTool('wm-related-topics', { id: source.metadata.id });
      expect(related).toMatchObject({ ok: true, result: { results: [{ id: meaningful.metadata.id, similarity: 1, evidence: 'semantic' }] } });
      expect((await client.topicSuggestPlacement(source.metadata.id)).suggestions[0].parent?.id).toBe(meaningful.metadata.id);
    } finally { await client.dispose(); await server.close(); }
  });

  it('bounds production hybrid ranking on 6500 topics with late distinctive text and 120 higher-BM25 near references', async () => {
    const store = openStore(':memory:');
    stores.push(store);
    new InstanceFeatureStore(store.db).write({ search: true });
    const workstream = store.createDocument({ kind: 'Workstream', spec: { title: 'Destination' } });
    const boilerplate = Array.from({ length: 180 }, (_, index) => `common${index}`).join(' ');
    const reference = 'zeta-82';
    const source = store.createDocument({ kind: 'Topic', spec: {
      title: 'Weekly journal', body: `${`${boilerplate}\n`.repeat(25)}\n${reference}`,
    } });
    const target = store.createDocument({ kind: 'Topic', spec: {
      title: 'Collected notes', body: `${`${boilerplate}\n`.repeat(25)}\n${reference}`, workstreams: [workstream.metadata.id],
    } });
    const meaningful = store.createDocument({ kind: 'Topic', spec: {
      title: 'Meaningful follow-up', body: 'An equivalent idea.', workstreams: [workstream.metadata.id],
    } });
    const documents = [workstream, source, target, meaningful];
    const nearIds = new Set<string>();
    for (let index = 0; index < 6497; index++) {
      const document = store.createDocument({ kind: 'Topic', spec: {
        title: index < 120 ? `${reference}-extra${index}` : `Corpus sample ${index}`,
        body: boilerplate, workstreams: [workstream.metadata.id],
      } });
      documents.push(document);
      if (index < 120) nearIds.add(document.metadata.id);
    }
    const unverified = store.db.prepare(`SELECT id FROM document_search WHERE document_search MATCH ? AND kind = 'Topic'
      ORDER BY bm25(document_search, 0, 0, 6, 1), id LIMIT 50`).all('"zeta-82"');
    expect(unverified).toHaveLength(50);
    expect(unverified.every(row => nearIds.has(String(row.id)))).toBe(true);
    new EmbeddingIndexer(store.db, () => true);
    const index = store.db.prepare('INSERT INTO topic_embedding_index VALUES (?, ?, ?, ?, ?, 1, ?)');
    const passage = store.db.prepare('INSERT INTO topic_embedding_passages VALUES (?, 0, ?, ?)');
    for (const document of documents) {
      const values = new Float32Array(384);
      if ([source.metadata.id, meaningful.metadata.id].includes(document.metadata.id)) values[0] = 1;
      else if (document.metadata.id === target.metadata.id) values[1] = 1;
      else { values[0] = 0.8; values[1] = 0.6; }
      const bytes = Buffer.from(values.buffer);
      index.run(document.metadata.id, EMBEDDING_MODEL, document.metadata.resourceVersion, '0'.repeat(64), bytes,
        Number([source.metadata.id, target.metadata.id].includes(document.metadata.id)));
      passage.run(document.metadata.id, String(document.spec.body ?? document.spec.title).slice(0, 600), bytes);
    }
    const plans = [
      store.db.prepare('EXPLAIN QUERY PLAN SELECT doc FROM document_search_vocabulary WHERE term = ?').all('common0'),
      store.db.prepare('EXPLAIN QUERY PLAN SELECT min(doc) FROM document_search_vocabulary WHERE term >= ? AND term < ? AND doc > 1').all('zet', 'zet\uffff'),
      store.db.prepare(`EXPLAIN QUERY PLAN SELECT document_search.id FROM document_search
        JOIN resources r ON r.rowid = document_search.rowid WHERE document_search MATCH ?
        AND document_search.id IN (SELECT value FROM json_each(?))
        AND wm_literal_evidence(document_search.title || char(10) ||
          CASE WHEN r.kind = 'Topic' AND json_type(r.spec, '$.body') IS NOT 'text' THEN '' ELSE document_search.body END, ?, 0) != ''
        ORDER BY bm25(document_search, 0, 0, 6, 1), document_search.id LIMIT 50`)
        .all('"zeta-82"', JSON.stringify(documents.map(document => document.metadata.id)), JSON.stringify([reference])),
      store.db.prepare(`EXPLAIN QUERY PLAN SELECT wm_literal_evidence(document_search.title || char(10) ||
          CASE WHEN r.kind = 'Topic' AND json_type(r.spec, '$.body') IS NOT 'text' THEN '' ELSE document_search.body END, ?, 2) AS matched_terms
        FROM document_search
        JOIN resources r ON r.rowid = document_search.rowid
        WHERE document_search MATCH ? AND document_search.id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(['common0', reference]), '"common0" OR "zeta-82"', JSON.stringify(documents.map(document => document.metadata.id))),
    ].map(rows => rows.map(row => String(row.detail)));
    for (const plan of plans.slice(0, 2)) expect(plan.join(' ')).toMatch(/VIRTUAL TABLE INDEX [1-9]/);
    expect(plans[2].join(' ')).toMatch(/document_search VIRTUAL TABLE INDEX \S*:M/);
    expect(plans[3].join(' ')).toMatch(/document_search VIRTUAL TABLE INDEX \S*:M/);
    const inference = await hostFixture();
    store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, ?)').run(JSON.stringify(inference.host));
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    const ranking = vi.spyOn(retrieval, 'hybridRanks');
    const timings: Record<string, number> = {};
    const originalLexical = retrieval.lexicalCandidates;
    let disabledLexical = false;
    let lexicalMetrics = { totalMs: 0, getMs: 0, prepareMs: 0, queries: 0, vocabularyQueries: 0, frequencyQueries: 0 };
    const lexical = vi.spyOn(retrieval, 'lexicalCandidates').mockImplementation((...args) => {
      lexicalMetrics = { totalMs: 0, getMs: 0, prepareMs: 0, queries: 0, vocabularyQueries: 0, frequencyQueries: 0 };
      if (disabledLexical) return new Map();
      const start = performance.now();
      const originalPrepare = args[0].prepare.bind(args[0]);
      const restore: Array<() => void> = [];
      const prepare = vi.spyOn(args[0], 'prepare').mockImplementation(sql => {
        const start = performance.now();
        const statement = originalPrepare(sql);
        lexicalMetrics.prepareMs += performance.now() - start;
        const originalGet = statement.get.bind(statement);
        const get = vi.spyOn(statement, 'get').mockImplementation((...parameters) => {
          const start = performance.now();
          lexicalMetrics.queries++;
          if (sql.includes('document_search_vocabulary')) lexicalMetrics.vocabularyQueries++;
          if (sql.includes('SELECT count(*)') && sql.includes('wm_literal_evidence')) lexicalMetrics.frequencyQueries++;
          try { return originalGet(...parameters); }
          finally { lexicalMetrics.getMs += performance.now() - start; }
        });
        const originalAll = statement.all.bind(statement);
        const all = vi.spyOn(statement, 'all').mockImplementation((...parameters) => {
          const start = performance.now();
          lexicalMetrics.queries++;
          if (sql.includes('count(*)') && sql.includes('wm_literal_evidence')) lexicalMetrics.frequencyQueries++;
          try {
            const rows = originalAll(...parameters);
            if (sql.includes('count(*)') && sql.includes('wm_literal_evidence')) {
              expect(rows.every(row => Number(row.count) <= args[1].size)).toBe(true);
            }
            return rows;
          }
          finally { lexicalMetrics.getMs += performance.now() - start; }
        });
        const originalIterate = statement.iterate.bind(statement);
        const iterate = vi.spyOn(statement, 'iterate').mockImplementation((...parameters) => {
          lexicalMetrics.queries++;
          if (!sql.includes('AS matched_terms')) return originalIterate(...parameters);
          lexicalMetrics.frequencyQueries++;
          const rows = originalIterate(...parameters);
          const counts = new Map<string, number>();
          return (function* () {
            try {
              for (;;) {
                const start = performance.now();
                const next = rows.next();
                lexicalMetrics.getMs += performance.now() - start;
                if (next.done) {
                  expect([...counts.values()].every(count => count <= args[1].size)).toBe(true);
                  return;
                }
                for (const term of JSON.parse(String(next.value.matched_terms)) as string[]) {
                  counts.set(term, (counts.get(term) ?? 0) + 1);
                }
                yield next.value;
              }
            } finally { rows.return?.(); }
          })();
        });
        restore.push(() => { get.mockRestore(); all.mockRestore(); iterate.mockRestore(); });
        return statement;
      });
      try { return originalLexical(...args); }
      finally {
        prepare.mockRestore();
        for (const cleanup of restore) cleanup();
        lexicalMetrics.totalMs = performance.now() - start;
      }
    });
    const profiles: Array<{ surface: string; mode: string; request: number; totalMs: number; lexical: typeof lexicalMetrics }> = [];
    const record = (surface: string, mode: string, request: number, totalMs: number) => {
      profiles.push({ surface, mode, request, totalMs, lexical: { ...lexicalMetrics } });
    };
    try {
      let start = performance.now();
      const search = await client.callTool('wm-semantic-search', { queries: [reference], kinds: ['Topic'], limit: 40 });
      timings.searchMs = performance.now() - start;
      record('search', 'hybrid', 0, timings.searchMs);
      if (!search.ok || !isDocumentSearchResult(search.result)) throw new Error('Invalid search result');
      expect(search.result.results.slice(0, 3).map(hit => hit.id)).toContain(target.metadata.id);
      expect(search.result.results.find(hit => hit.id === target.metadata.id)).toMatchObject({ literalMatch: true, similarity: 0 });
      expect(search.result.results.filter(hit => nearIds.has(hit.id)).every(hit => !hit.literalMatch)).toBe(true);
      start = performance.now();
      const related = await client.callTool('wm-related-topics', { id: source.metadata.id, limit: 10 });
      timings.relatedMs = performance.now() - start;
      record('related', 'hybrid', 0, timings.relatedMs);
      if (!related.ok) throw new Error(related.error);
      const hits = relatedTopicsSchema.parse(related.result).results;
      expect(hits[0]).toMatchObject({ id: target.metadata.id, evidence: 'keyword', similarity: 0,
        excerpt: expect.stringContaining(reference) });
      expect(hits.some(hit => hit.id === meaningful.metadata.id && hit.evidence === 'semantic')).toBe(true);
      expect(hits.filter(hit => nearIds.has(hit.id)).every(hit => hit.evidence === 'semantic')).toBe(true);
      start = performance.now();
      const placement = await client.topicSuggestPlacement(source.metadata.id);
      timings.placementMs = performance.now() - start;
      record('placement', 'hybrid', 0, timings.placementMs);
      expect(placement.suggestions[0]).toMatchObject({ parent: { id: target.metadata.id }, similarity: 0,
        excerpt: expect.stringContaining(reference) });
      for (const [, lexical] of ranking.mock.calls) expect(lexical.size).toBeLessThanOrEqual(50);
      const sizes = ranking.mock.results.map(result => result.value.size);
      expect(sizes.some(size => size > 50)).toBe(true);
      expect(sizes.every(size => size <= 100)).toBe(true);
      for (const mode of ['hybrid', 'lexical-disabled']) {
        disabledLexical = mode === 'lexical-disabled';
        for (let request = disabledLexical ? 0 : 1; request < 4; request++) {
          let start = performance.now();
          const search = await client.callTool('wm-semantic-search', { queries: [reference], kinds: ['Topic'], limit: 40 });
          if (!search.ok) throw new Error(search.error);
          record('search', mode, request, performance.now() - start);
          start = performance.now();
          const related = await client.callTool('wm-related-topics', { id: source.metadata.id, limit: 10 });
          if (!related.ok) throw new Error(related.error);
          record('related', mode, request, performance.now() - start);
          start = performance.now();
          await client.topicSuggestPlacement(source.metadata.id);
          record('placement', mode, request, performance.now() - start);
        }
      }
      process.stdout.write(`${JSON.stringify({ topics: 6500, nearReferences: 120, plans, profiles, fusedCandidateSizes: sizes })}\n`);
      expect(store.getDocument({ id: source.metadata.id })).toEqual(source);
    } finally { lexical.mockRestore(); ranking.mockRestore(); await client.dispose(); await server.close(); }
  }, 60000);

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
  it.each([false, true])('finds exact case references inside Re: search phrases ahead of different case numbers through authenticated MCP (literalQuery=%s)', async includeLiteralQuery => {
    const { store } = fixture();
    const caseId = '20261411192068475308';
    const exact = store.createDocument({ kind: 'Topic', spec: { title: 'Case file',
      body: `${'A'.repeat(33000)}\nCase ${caseId}` } });
    const semantic = store.createDocument({ kind: 'Topic', spec: { title: 'jubberish topic 20261411192068475309',
      body: 'The orange beetle wrote a postcard to Saturn.' } });
    for (const title of [`X${caseId}`, `${caseId}0`, `${caseId}_notes`]) {
      store.createDocument({ kind: 'Topic', spec: { title } });
    }
    for (;;) {
      const work = nextEmbeddingWork(store.db).work;
      if (!work) break;
      submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion, contentHash: work.contentHash,
        model: EMBEDDING_MODEL, vectors: work.passages.map(() => Array.from({ length: 384 },
          (_, index) => Number(index === (work.id === exact.metadata.id ? 1 : 0)))) });
    }
    const inference = await hostFixture();
    new EmbeddingIndexer(store.db, () => true);
    store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, ?)').run(JSON.stringify(inference.host));
    const server = await startServer({ port: 0, store });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      expect(await client.callTool('wm-semantic-search', {
        queries: [`Re: ${caseId}`], ...(includeLiteralQuery ? { literalQuery: `Re: ${caseId}` } : {}), kinds: ['Topic'], limit: 1,
      })).toMatchObject({ ok: true, result: { count: 1, limited: true, results: [{
        id: exact.metadata.id, resourceVersion: exact.metadata.resourceVersion, literalMatch: true,
        similarity: 0, confidence: { level: 'high' }, excerpt: expect.stringContaining(caseId),
      }] } });
      const all = await client.callTool('wm-semantic-search', { queries: [`Re: ${caseId}`], kinds: ['Topic'], limit: 40 });
      expect(all).toMatchObject({ ok: true, result: { results: [
        expect.objectContaining({ id: exact.metadata.id, literalMatch: true }), ...Array(4).fill(expect.any(Object)),
      ] } });
      if (!all.ok) throw new Error(all.error);
      if (!isDocumentSearchResult(all.result)) throw new Error('Invalid search result');
      const results = all.result.results;
      expect(results.filter(hit => hit.literalMatch).map(hit => hit.id)).toEqual([exact.metadata.id]);
      expect(results.find(hit => hit.id === semantic.metadata.id)?.similarity).toBe(1);
      expect(await client.callTool('wm-semantic-search', { queries: ['2026'], kinds: ['Topic'], limit: 40 }))
        .toMatchObject({ ok: true, result: { count: 4 } });
      expect(await client.callTool('wm-semantic-search', { queries: [`Re: X${caseId}`], kinds: ['Topic'], limit: 40 }))
        .toMatchObject({ ok: true, result: { count: 4 } });
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
