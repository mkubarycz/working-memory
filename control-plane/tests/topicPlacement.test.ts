import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadKinds } from '../src/kinds/loader';
import { openStore, type Store } from '../src/store';
import { EMBEDDING_MODEL } from '../src/embeddingContract';
import { nextEmbeddingWork, submitEmbeddings } from '../src/topicEmbeddings';
import { ControlPlaneClient, startServer } from '../../tests/authenticatedFixture';
import { InstanceFeatureStore } from '../src/instanceFeatures';
import { instanceToolPermissions } from '../src/instanceAuthorization';
import { topicPlacementApplySchema, topicPlacementSchema } from '../src/topicPlacementContract';

let store: Store;
beforeAll(async () => { await loadKinds(); });
afterEach(() => store?.close());
function indexAll(direction: (id: string) => number = () => 0) {
  for (;;) {
    const work = nextEmbeddingWork(store.db).work;
    if (!work) return;
    submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion,
      contentHash: work.contentHash, model: EMBEDDING_MODEL,
      vectors: work.passages.map(() => Array.from({ length: 384 }, (_, i) => Number(i === direction(work.id)))) });
  }
}
async function setup() {
  store = openStore(':memory:');
  store.createDocument({ kind: 'TopicType', spec: { label: 'Topic', icon: 'notebook' } });
  new InstanceFeatureStore(store.db).write({ search: true });
  const server = await startServer({ port: 0, store });
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
  return { server, client };
}
const applyInput = (id: string, version: number, parent: { id: string; resourceVersion: number } | null,
  workstream: { id: string; resourceVersion: number }) =>
  topicPlacementApplySchema.parse({ id, expectedResourceVersion: version,
    parent: parent ? { id: parent.id, resourceVersion: parent.resourceVersion } : null,
    workstream: { id: workstream.id, resourceVersion: workstream.resourceVersion } });

describe('topic placement production MCP/client entry points', () => {
  it.each(['title', 'body'] as const)('prioritizes exact case identity from the source %s before cosine limits without bypassing parent eligibility', async field => {
    const { server, client } = await setup();
    try {
      const caseId = '20261411192068475308';
      const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'Cases' } });
      const closedWs = store.createDocument({ kind: 'Workstream', spec: { title: 'Old cases', status: 'closed' } });
      const source = store.createDocument({ kind: 'Topic', spec: field === 'title'
        ? { title: `Re: ${caseId}` } : { title: 'Follow-up', body: `${'A'.repeat(33000)}\nRe: ${caseId}` } });
      const exact = store.createDocument({ kind: 'Topic', spec: { title: 'Case file',
        body: `${'B'.repeat(33000)}\nCase ${caseId}`, workstreams: [ws.metadata.id] } });
      const different = store.createDocument({ kind: 'Topic', spec: { title: 'jubberish topic 20261411192068475309',
        body: 'The blue beetle sent a postcard to a marmalade star.', workstreams: [ws.metadata.id] } });
      for (const title of [`X${caseId}`, `${caseId}0`, `${caseId}_notes`]) {
        store.createDocument({ kind: 'Topic', spec: { title, workstreams: [ws.metadata.id] } });
      }
      const ineligible = [
        store.createDocument({ kind: 'Topic', spec: { title: `Unplaced ${caseId}` } }),
        store.createDocument({ kind: 'Topic', spec: { title: `Closed ${caseId}`, status: 'closed', workstreams: [ws.metadata.id] } }),
        store.createDocument({ kind: 'Topic', spec: { title: `Old ${caseId}`, workstreams: [closedWs.metadata.id] } }),
        store.createDocument({ kind: 'Topic', spec: { title: `Child ${caseId}`, parents: [source.metadata.id], workstreams: [ws.metadata.id] } }),
      ];
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      indexAll(id => id === exact.metadata.id ? 1 : 0);
      const response = await client.callTool('wm-topic-suggest-placement', { id: source.metadata.id, limit: 1 });
      if (!response.ok) throw new Error(response.error);
      const capped = topicPlacementSchema.parse(response.result);
      expect(capped).toMatchObject({ state: 'ready', sourceVersion: source.metadata.resourceVersion,
        suggestions: [{ parent: { id: exact.metadata.id, resourceVersion: exact.metadata.resourceVersion },
          workstream: { id: ws.metadata.id }, similarity: 0,
          confidence: { level: 'high', reason: expect.stringContaining('verifies the text match') },
          excerpt: expect.stringContaining(caseId), evidence: 'parent-membership' }] });
      const all = await client.topicSuggestPlacement(source.metadata.id);
      expect(all.suggestions[0].parent?.id).toBe(exact.metadata.id);
      expect(all.suggestions.some(s => s.parent?.id === different.metadata.id && s.similarity === 1)).toBe(true);
      expect(all.suggestions.some(s => ineligible.some(doc => doc.metadata.id === s.parent?.id))).toBe(false);
      expect(all.suggestions.slice(1).every(s => !s.confidence.reason.includes('verifies the text match'))).toBe(true);
      expect(store.getDocument({ id: source.metadata.id })).toEqual(source);
    } finally { await client.dispose(); await server.close(); }
  });

  it('transparently reports readiness, suggests parent/workstream pairs, and only applies explicitly', async () => {
    const { server, client } = await setup();
    try {
      const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'Embedding workstream' } });
      const parent = store.createDocument({ kind: 'Topic', spec: { title: 'Embedding parent', workstreams: [ws.metadata.id] } });
      const source = await client.topicCreate({ title: 'Embedding child', body: 'Authored text' });
      expect(await client.topicSuggestPlacement(source.id)).toMatchObject({ state: 'disabled', suggestions: [] });
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      expect(await client.topicSuggestPlacement(source.id)).toMatchObject({ state: 'pending', suggestions: [] });
      indexAll();
      const result = await client.topicSuggestPlacement(source.id);
      expect(result.state).toBe('ready');
      const suggestion = result.suggestions.find(candidate => candidate.parent?.id === parent.metadata.id)!;
      expect(suggestion).toMatchObject({ parent: { id: parent.metadata.id }, workstream: { id: ws.metadata.id },
        similarity: 1, evidence: 'parent-membership' });
      expect(store.getDocument({ id: source.id })!.spec.parents ?? []).toEqual([]);
      const input = applyInput(source.id, result.sourceVersion, suggestion.parent, suggestion.workstream);
      const updated = await client.topicApplyPlacement(input);
      expect(updated.spec).toMatchObject({ parents: [parent.metadata.id], workstreams: [ws.metadata.id],
        title: 'Embedding child', body: 'Authored text', status: 'open', focusedWorkstreams: [] });
      await expect(client.topicApplyPlacement(input)).rejects.toThrow(/topic changed/i);
      expect(instanceToolPermissions('wm-topic-suggest-placement', {}, store)).toEqual([{ category: 'content', operation: 'read' }]);
      expect(instanceToolPermissions('wm-topic-apply-placement', {}, store)).toEqual([
        { category: 'content', operation: 'read' }, { category: 'content', operation: 'update' },
      ]);
    } finally { await client.dispose(); await server.close(); }
  });

  it('excludes self/descendants and rejects a newly cyclic or stale selected parent at apply time', async () => {
    const { server, client } = await setup();
    try {
      const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'Graph workstream' } });
      const source = store.createDocument({ kind: 'Topic', spec: { title: 'Source' } });
      const child = store.createDocument({ kind: 'Topic', spec: { title: 'Child', parents: [source.metadata.id], workstreams: [ws.metadata.id] } });
      const grandchild = store.createDocument({ kind: 'Topic', spec: { title: 'Grandchild', parents: [child.metadata.id], workstreams: [ws.metadata.id] } });
      const candidate = store.createDocument({ kind: 'Topic', spec: { title: 'Candidate', workstreams: [ws.metadata.id] } });
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      indexAll();
      const result = await client.topicSuggestPlacement(source.metadata.id);
      expect(result.suggestions.some(s => [source.metadata.id, child.metadata.id, grandchild.metadata.id].includes(s.parent?.id ?? ''))).toBe(false);
      const selected = result.suggestions.find(s => s.parent?.id === candidate.metadata.id)!;
      const stale = applyInput(source.metadata.id, result.sourceVersion, selected.parent, selected.workstream);
      const changed = store.updateDocument({ id: candidate.metadata.id, expectedResourceVersion: candidate.metadata.resourceVersion,
        spec: { ...candidate.spec, parents: [grandchild.metadata.id] } });
      await expect(client.topicApplyPlacement(stale)).rejects.toThrow(/parent changed/i);
      await expect(client.topicApplyPlacement({ ...stale,
        parent: { id: changed.metadata.id, resourceVersion: changed.metadata.resourceVersion } })).rejects.toThrow(/descendant/i);
      await expect(client.topicApplyPlacement({ ...stale,
        parent: { id: source.metadata.id, resourceVersion: source.metadata.resourceVersion } })).rejects.toThrow(/own parent/i);
      expect(store.getDocument({ id: source.metadata.id })!.metadata.resourceVersion).toBe(result.sourceVersion);
    } finally { await client.dispose(); await server.close(); }
  });

  it('rejects changed/closed workstreams and missing parents without changing any topic', async () => {
    const { server, client } = await setup();
    try {
      const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'Destination' } });
      const topic = store.createDocument({ kind: 'Topic', spec: { title: 'Topic' } });
      const input = applyInput(topic.metadata.id, topic.metadata.resourceVersion, null,
        { id: ws.metadata.id, resourceVersion: ws.metadata.resourceVersion });
      store.updateDocument({ id: ws.metadata.id, expectedResourceVersion: ws.metadata.resourceVersion, spec: { ...ws.spec, title: 'Renamed' } });
      await expect(client.topicApplyPlacement(input)).rejects.toThrow(/workstream changed/i);
      const latest = store.getDocument({ id: ws.metadata.id })!;
      await expect(client.topicApplyPlacement({ ...input, workstream: { id: ws.metadata.id, resourceVersion: latest.metadata.resourceVersion },
        parent: { id: 'missing', resourceVersion: 1 } })).rejects.toThrow(/parent topic/i);
      store.updateDocument({ id: ws.metadata.id, expectedResourceVersion: latest.metadata.resourceVersion,
        spec: { ...latest.spec, status: 'closed' } });
      await expect(client.topicApplyPlacement(input)).rejects.toThrow(/no longer open/i);
      expect(store.getDocument({ id: topic.metadata.id })!.spec.workstreams ?? []).toEqual([]);
    } finally { await client.dispose(); await server.close(); }
  });

  it('rechecks the current graph even when the selected parent version has not changed', async () => {
    const { server, client } = await setup();
    try {
      const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'Workstream' } });
      const source = store.createDocument({ kind: 'Topic', spec: { title: 'Source' } });
      const bridge = store.createDocument({ kind: 'Topic', spec: { title: 'Bridge' } });
      const parent = store.createDocument({ kind: 'Topic', spec: { title: 'Candidate', parents: [bridge.metadata.id],
        workstreams: [ws.metadata.id] } });
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      indexAll();
      const result = await client.topicSuggestPlacement(source.metadata.id);
      const suggestion = result.suggestions.find(s => s.parent?.id === parent.metadata.id)!;
      store.updateDocument({ id: bridge.metadata.id, expectedResourceVersion: bridge.metadata.resourceVersion,
        spec: { ...bridge.spec, parents: [source.metadata.id] } });
      await expect(client.topicApplyPlacement(applyInput(source.metadata.id, result.sourceVersion,
        suggestion.parent, suggestion.workstream))).rejects.toThrow(/descendant/i);
      expect(store.getDocument({ id: source.metadata.id })!.metadata.resourceVersion).toBe(result.sourceVersion);
    } finally { await client.dispose(); await server.close(); }
  });
});
