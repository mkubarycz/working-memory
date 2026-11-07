import { beforeAll, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { EmbeddingRuntime, installEmbeddingModel } from '../src/main/embeddingRuntime';
import { EMBEDDING_MODEL } from '../../control-plane/src/embeddingContract';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { openStore } from '../../control-plane/src/store';
import { InstanceFeatureStore } from '../../control-plane/src/instanceFeatures';
import { ControlPlaneClient, startServer } from '../../tests/authenticatedFixture';
import { embeddingBatchSchema, relatedTopicsSchema } from '../../control-plane/src/embeddingContract';

beforeAll(async () => { if (process.env.WM_TEST_EMBEDDINGS === '1') await loadKinds(); });
it.skipIf(process.env.WM_TEST_EMBEDDINGS !== '1')('installs verified weights and indexes through the bundled host helper and authenticated MCP', async () => {
  const directory = resolve('../.cache/embedding-integration-model');
  const helper = process.env.WM_EMBEDDING_HELPER || resolve('build/embeddings/wm-embeddings',
    process.platform === 'win32' ? 'wm-embeddings.exe' : 'wm-embeddings');
  const runtime = new EmbeddingRuntime(helper, directory);
  const signal = AbortSignal.timeout(300000);
  const store = openStore(':memory:');
  new InstanceFeatureStore(store.db).write({ search: true });
  const source = store.createDocument({ kind: 'Topic', spec: {
    title: 'Private network outage', body: 'The router cannot reach the remote service. Connections fail and packets are dropped.',
  } });
  const related = store.createDocument({ kind: 'Topic', spec: {
    title: 'Connectivity recovery', body: 'Restore routing to the server and investigate dropped packets and connection failures.',
  } });
  store.createDocument({ kind: 'Topic', spec: {
    title: 'Baking bread', body: 'Mix flour, yeast and water. Knead the dough and bake a loaf in the oven.',
  } });
  const server = await startServer({ port: 0, store });
  store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
  try {
    await installEmbeddingModel(directory, signal, () => {});
    const startup = performance.now();
    await runtime.start(signal);
    const startupMs = performance.now() - startup;
    if (process.env.WM_REQUIRE_INTEL_NPU === '1') expect(runtime.backend).toMatch(/^OpenVINO \/ NPU/);
    const timings: number[] = [];
    for (let index = 0; index < 3; index++) {
      const next = await client.callTool('wm-embeddings-next', {}, signal);
      if (!next.ok) throw new Error(next.error);
      const work = embeddingBatchSchema.parse(next.result).work!;
      const result = await runtime.embed(work.passages, signal);
      timings.push(result.durationMs);
      const saved = await client.callTool('wm-embeddings-submit', { id: work.id,
        sourceVersion: work.sourceVersion, contentHash: work.contentHash, model: EMBEDDING_MODEL,
        vectors: result.vectors }, signal);
      expect(saved.ok).toBe(true);
    }
    const started = performance.now();
    const response = await client.callTool('wm-related-topics', { id: source.metadata.id }, signal);
    if (!response.ok) throw new Error(response.error);
    const result = relatedTopicsSchema.parse(response.result);
    const relatedMs = performance.now() - started;
    expect(result.state).toBe('ready');
    expect(result.results[0].id).toBe(related.metadata.id);
    expect(result.results[0].evidence).toBe('semantic');
    expect(result.results[0].similarity).toBeGreaterThan(0.5);
    expect(runtime.rssBytes).toBeGreaterThan(0);
    const centroid = store.db.prepare('SELECT centroid FROM topic_embedding_index WHERE topic_id = ?')
      .get(source.metadata.id)!.centroid;
    if (!(centroid instanceof Uint8Array)) throw new Error('Missing benchmark centroid.');
    const insert = store.db.prepare(`INSERT INTO resources(id, kind, labels, spec, status, created_at, updated_at, resource_version)
      VALUES (?, 'Topic', '{}', ?, '{}', 1, 1, 1)`);
    const addIndex = store.db.prepare(`INSERT INTO topic_embedding_index
      (topic_id, model_id, source_version, content_hash, centroid, indexed_at, limited) VALUES (?, ?, 1, ?, ?, 1, 0)`);
    store.db.exec('BEGIN');
    for (let i = 0; i < 10000; i++) {
      const id = `benchmark-${i}`;
      insert.run(id, JSON.stringify({ title: `Benchmark ${i}`, body: 'Synthetic candidate for retrieval scaling.' }));
      addIndex.run(id, EMBEDDING_MODEL, 'b'.repeat(64), centroid);
    }
    store.db.exec('COMMIT');
    const warm = await client.callTool('wm-related-topics', { id: source.metadata.id }, signal);
    expect(warm.ok).toBe(true);
    const scaled = performance.now();
    const scaledResponse = await client.callTool('wm-related-topics', { id: source.metadata.id }, signal);
    const scaledRelatedMs = performance.now() - scaled;
    expect(scaledResponse.ok).toBe(true);
    if (scaledResponse.ok) expect(relatedTopicsSchema.parse(scaledResponse.result).results.length).toBe(6);
    expect(scaledRelatedMs).toBeLessThan(300);
    console.log(JSON.stringify({ backend: runtime.backend, warning: runtime.warning, startupMs,
      inferenceMs: timings, relatedMs, scaledRelatedMs, benchmarkTopics: 10003,
      helperRssMiB: runtime.rssBytes! / 1048576 }));
  } finally { runtime.stop(); await client.dispose(); await server.close(); store.close(); }
}, 360000);
