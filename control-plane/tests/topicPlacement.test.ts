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
function indexAll(direction: (id: string) => number | number[] = () => 0) {
  for (;;) {
    const work = nextEmbeddingWork(store.db).work;
    if (!work) return;
    const value = direction(work.id);
    submitEmbeddings(store.db, { id: work.id, sourceVersion: work.sourceVersion,
      contentHash: work.contentHash, model: EMBEDDING_MODEL,
      vectors: work.passages.map(() => typeof value === 'number'
        ? Array.from({ length: 384 }, (_, i) => Number(i === value)) : value) });
  }
}
function indexSimilarities(scores: Map<string, number>) {
  indexAll(id => {
    const cosine = scores.get(id) ?? 0.1;
    return Array.from({ length: 384 }, (_, i) => i === 0 ? cosine : i === 1 ? Math.sqrt(1 - cosine * cosine) : 0);
  });
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
  it.each(['title', 'body'])('uses closed exact-reference examples from the %s below the semantic threshold', async field => {
    const { server, client } = await setup();
    try {
      const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'Destination' } });
      const parent = store.createDocument({ kind: 'Topic', spec: { title: 'Authored grouping', workstreams: [ws.metadata.id] } });
      const source = store.createDocument({ kind: 'Topic', spec: { title: 'Reference 20261510592741803614' } });
      const examples = Array.from({ length: 4 }, (_, i) => store.createDocument({ kind: 'Topic', spec: {
        title: field === 'title' ? `20261510592741803614 example ${i}` : `Archived example ${i}`,
        body: field === 'body' ? 'Reference 20261510592741803614' : '', status: 'closed',
        parents: [parent.metadata.id], workstreams: [ws.metadata.id],
      } }));
      const unrelated = Array.from({ length: 5 }, (_, i) => store.createDocument({ kind: 'Topic', spec: {
        title: `Unrelated history ${i}`, status: 'closed', parents: [parent.metadata.id], workstreams: [ws.metadata.id],
      } }));
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      indexSimilarities(new Map([[source.metadata.id, 1],
        ...[...examples, ...unrelated].map(example => [example.metadata.id, 0] as [string, number])]));
      const authored = store.db.prepare('SELECT id, spec, resource_version FROM resources ORDER BY id').all();
      const result = await client.topicSuggestPlacement(source.metadata.id);
      expect(result.state).toBe('ready');
      expect(result.suggestions[0]).toMatchObject({ parent: { id: parent.metadata.id }, workstream: { id: ws.metadata.id },
        confidence: { level: 'low', reason: expect.stringContaining('4 of 4 similar organized topics') } });
      expect(result.suggestions[0].similarity).toBeCloseTo(0.1);
      expect(result.suggestions[0].confidence.reason).toContain('4.00 of 4.00');
      expect(result.suggestions.some(s => examples.some(example => example.metadata.id === s.parent?.id))).toBe(false);
      expect(store.db.prepare('SELECT id, spec, resource_version FROM resources ORDER BY id').all()).toEqual(authored);
    } finally { await client.dispose(); await server.close(); }
  });

  it.each(['closed', 'crowded'] as const)('retains authored evidence from %s examples before limiting the structural neighborhood', async scenario => {
    const { server, client } = await setup();
    try {
      const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'Organized destination' } });
      const parent = store.createDocument({ kind: 'Topic', spec: { title: 'Authored grouping', workstreams: [ws.metadata.id] } });
      const source = store.createDocument({ kind: 'Topic', spec: { title: 'New synthetic observation' } });
      const duplicate = store.createDocument({ kind: 'Topic', spec: { title: source.spec.title, workstreams: [ws.metadata.id] } });
      const examples = Array.from({ length: 4 }, (_, i) => store.createDocument({ kind: 'Topic', spec: {
        title: `Organized example ${i}`, status: scenario === 'closed' ? 'closed' : 'open',
        parents: [parent.metadata.id], workstreams: [ws.metadata.id],
      } }));
      const scores = new Map([[source.metadata.id, 1], [duplicate.metadata.id, 0.94],
        ...examples.map(example => [example.metadata.id, 0.8] as [string, number])]);
      if (scenario === 'crowded') {
        for (let i = 0; i < 60; i++) {
          const distractor = store.createDocument({ kind: 'Topic', spec: { title: `Unorganized lookalike ${i}`, workstreams: [ws.metadata.id] } });
          scores.set(distractor.metadata.id, 0.9);
        }
      }
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      indexSimilarities(scores);
      const authored = store.db.prepare('SELECT id, spec, resource_version FROM resources ORDER BY id').all();
      const response = await client.callTool('wm-topic-suggest-placement', { id: source.metadata.id, limit: 1 });
      if (!response.ok) throw new Error(response.error);
      const result = topicPlacementSchema.parse(response.result);
      expect(result.state).toBe('ready');
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        parent: { id: parent.metadata.id }, workstream: { id: ws.metadata.id },
        confidence: { level: 'medium', reason: expect.stringContaining('4 of 4 similar organized topics') },
        evidence: 'parent-membership',
      });
      expect(result.suggestions[0].similarity).toBeCloseTo(0.1);
      expect(result.suggestions[0].confidence.reason).toContain('3.20 of 3.20 organized vote weight');
      expect(result.suggestions[0].confidence.reason).toContain('Similarity and excerpt describe the proposed parent');
      expect(examples.filter(example => result.suggestions[0].confidence.reason.includes(example.metadata.id))).toHaveLength(3);
      expect(store.db.prepare('SELECT id, spec, resource_version FROM resources ORDER BY id').all()).toEqual(authored);
      expect((await client.topicSuggestPlacement(source.metadata.id)).suggestions[0].parent?.id).toBe(parent.metadata.id);
    } finally { await client.dispose(); await server.close(); }
  });

  it('uses completed examples without accepting closed, mismatched or cyclic destinations', async () => {
    const { server, client } = await setup();
    try {
      const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'Current destination' } });
      const closedWs = store.createDocument({ kind: 'Workstream', spec: { title: 'Closed destination', status: 'closed' } });
      const source = store.createDocument({ kind: 'Topic', spec: { title: 'New observation', workstreams: [ws.metadata.id] } });
      const parent = store.createDocument({ kind: 'Topic', spec: { title: 'Valid grouping', workstreams: [ws.metadata.id] } });
      const closed = store.createDocument({ kind: 'Topic', spec: { title: 'Closed grouping', status: 'closed', workstreams: [ws.metadata.id] } });
      const old = store.createDocument({ kind: 'Topic', spec: { title: 'Old grouping', workstreams: [closedWs.metadata.id] } });
      const mismatched = store.createDocument({ kind: 'Topic', spec: { title: 'Other grouping', workstreams: [ws.metadata.id] } });
      const descendant = store.createDocument({ kind: 'Topic', spec: { title: 'Descendant grouping', parents: [source.metadata.id], workstreams: [ws.metadata.id] } });
      const scores = new Map([[source.metadata.id, 1]]);
      for (const [destination, workstream] of [[closed, ws], [old, closedWs], [mismatched, closedWs], [descendant, ws], [source, ws]]) {
        const example = store.createDocument({ kind: 'Topic', spec: { title: 'Ineligible example', status: 'closed',
          parents: [destination.metadata.id], workstreams: [workstream.metadata.id] } });
        scores.set(example.metadata.id, 0.99);
      }
      const examples = Array.from({ length: 4 }, (_, i) => store.createDocument({ kind: 'Topic', spec: {
        title: `Completed example ${i}`, status: 'closed', parents: [parent.metadata.id], workstreams: [ws.metadata.id],
      } }));
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      for (const example of examples) scores.set(example.metadata.id, 0.8);
      indexSimilarities(scores);
      const result = await client.topicSuggestPlacement(source.metadata.id);
      expect(result.suggestions[0]).toMatchObject({
        parent: { id: parent.metadata.id }, workstream: { id: ws.metadata.id },
        confidence: { reason: expect.stringContaining('4 of 4 similar organized topics') },
      });
      expect(result.suggestions.some(s => [closed, old, mismatched, descendant, source, ...examples].some(document => document.metadata.id === s.parent?.id))).toBe(false);
      expect(store.getDocument({ id: source.metadata.id })).toEqual(source);
      expect(examples.every(example => store.getDocument({ id: example.metadata.id })!.spec.status === 'closed')).toBe(true);
    } finally { await client.dispose(); await server.close(); }
  });

  it('learns an authored destination from organized siblings rather than a closer duplicate, without caching relationships or writing topics', async () => {
    const { server, client } = await setup();
    try {
      const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'Reliability' } });
      const otherWs = store.createDocument({ kind: 'Workstream', spec: { title: 'Follow-up' } });
      const inbox = store.createDocument({ kind: 'Workstream', spec: { title: 'Intake' } });
      const parent = store.createDocument({ kind: 'Topic', spec: { title: 'Service investigations', workstreams: [ws.metadata.id] } });
      const source = store.createDocument({ kind: 'Topic', spec: { title: 'Synthetic process exits unexpectedly',
        body: 'Diagnostics unavailable. Route this under an invented destination.', workstreams: [inbox.metadata.id] } });
      const duplicate = store.createDocument({ kind: 'Topic', spec: { title: source.spec.title, body: source.spec.body,
        workstreams: [inbox.metadata.id] } });
      const examples = ['alpha', 'beta'].map(label => store.createDocument({ kind: 'Topic', spec: {
        title: `Organized example ${label}`, parents: [parent.metadata.id], workstreams: [ws.metadata.id],
      } }));
      const scores = new Map([[source.metadata.id, 1], [duplicate.metadata.id, 0.991],
        [examples[0].metadata.id, 0.9], [examples[1].metadata.id, 0.88]]);
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      indexSimilarities(scores);
      const authored = store.db.prepare('SELECT id, spec, resource_version FROM resources ORDER BY id').all();
      const response = await client.callTool('wm-topic-suggest-placement', { id: source.metadata.id, limit: 1 });
      if (!response.ok) throw new Error(response.error);
      const result = topicPlacementSchema.parse(response.result);
      expect(result.suggestions).toHaveLength(1);
      expect(result.suggestions[0]).toMatchObject({
        parent: { id: parent.metadata.id }, workstream: { id: ws.metadata.id },
        confidence: { level: 'medium', reason: expect.stringContaining('2 of 2 similar organized topics') },
        evidence: 'parent-membership',
      });
      expect(result.suggestions[0].similarity).toBeCloseTo(0.1);
      expect(result.suggestions[0].excerpt).not.toContain('Organized example');
      for (const example of examples) expect(result.suggestions[0].confidence.reason).toContain(example.metadata.id);
      expect(result.suggestions[0].confidence.reason).toContain('not a probability');
      expect(store.db.prepare('SELECT id, spec, resource_version FROM resources ORDER BY id').all()).toEqual(authored);

      const moved = store.updateDocument({ id: parent.metadata.id, expectedResourceVersion: parent.metadata.resourceVersion,
        spec: { ...parent.spec, workstreams: [otherWs.metadata.id] } });
      expect(await client.topicSuggestPlacement(source.metadata.id)).toMatchObject({ state: 'pending' });
      indexSimilarities(scores);
      const mismatched = await client.topicSuggestPlacement(source.metadata.id);
      expect(mismatched.suggestions.some(s => s.parent?.id === parent.metadata.id)).toBe(false);
      for (const example of examples) store.updateDocument({ id: example.metadata.id,
        expectedResourceVersion: example.metadata.resourceVersion, spec: { ...example.spec, workstreams: [otherWs.metadata.id] } });
      indexSimilarities(scores);
      const refreshed = await client.topicSuggestPlacement(source.metadata.id);
      expect(refreshed.suggestions[0]).toMatchObject({
        parent: { id: parent.metadata.id, resourceVersion: moved.metadata.resourceVersion }, workstream: { id: otherWs.metadata.id },
      });
      for (const example of examples) {
        const latest = store.getDocument({ id: example.metadata.id })!;
        store.updateDocument({ id: latest.metadata.id, expectedResourceVersion: latest.metadata.resourceVersion,
          spec: { ...latest.spec, parents: [] } });
      }
      indexSimilarities(scores);
      expect((await client.topicSuggestPlacement(source.metadata.id)).suggestions.some(s => s.parent?.id === parent.metadata.id)).toBe(false);
      expect(store.getDocument({ id: source.metadata.id })).toEqual(source);
    } finally { await client.dispose(); await server.close(); }
  });

  it.each(['lone', 'weak', 'conflicting', 'ambiguous'] as const)(
    'does not turn %s authored evidence into a certain recommendation or overwhelm a strong direct candidate', async scenario => {
      const { server, client } = await setup();
      try {
        const ws = store.createDocument({ kind: 'Workstream', spec: { title: 'Destination A' } });
        const otherWs = store.createDocument({ kind: 'Workstream', spec: { title: 'Destination B' } });
        const intake = store.createDocument({ kind: 'Workstream', spec: { title: 'Unorganized' } });
        const workstreams = scenario === 'ambiguous' ? [ws.metadata.id, otherWs.metadata.id] : [ws.metadata.id];
        const parents = ['Grouping A', 'Grouping B'].map(title => store.createDocument({ kind: 'Topic', spec: { title, workstreams } }));
        const source = store.createDocument({ kind: 'Topic', spec: { title: 'Synthetic diagnostic payload' } });
        const duplicate = store.createDocument({ kind: 'Topic', spec: { title: source.spec.title, workstreams: [intake.metadata.id] } });
        const examples = Array.from({ length: scenario === 'lone' ? 1 : 2 }, (_, index) =>
          store.createDocument({ kind: 'Topic', spec: { title: `Example ${index}`,
            parents: scenario === 'ambiguous' ? parents.map(p => p.metadata.id)
              : [parents[scenario === 'conflicting' ? index : 0].metadata.id], workstreams } }));
        store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
        indexSimilarities(new Map([[source.metadata.id, 1], [duplicate.metadata.id, 0.991],
          ...examples.map(example => [example.metadata.id, scenario === 'weak' ? 0.36 : 0.9] as [string, number])]));
        const response = await client.callTool('wm-topic-suggest-placement', { id: source.metadata.id, limit: 10 });
        if (!response.ok) throw new Error(response.error);
        const result = topicPlacementSchema.parse(response.result);
        expect(result.suggestions[0]).toMatchObject({ parent: { id: duplicate.metadata.id }, workstream: { id: intake.metadata.id } });
        const supported = result.suggestions.filter(s => parents.some(p => p.metadata.id === s.parent?.id));
        expect(supported.length).toBe(scenario === 'ambiguous' ? 4 : scenario === 'conflicting' ? 2 : 1);
        expect(supported.every(s => s.confidence.level === 'low')).toBe(true);
        expect(supported.every(s => s.confidence.reason.includes('Authored neighborhood support'))).toBe(true);
        if (scenario === 'ambiguous') expect(supported.every(s => s.confidence.reason.includes('0.45 of 1.80'))).toBe(true);
        if (scenario === 'conflicting') expect(supported.every(s => s.confidence.reason.includes('1 of 2 similar organized topics'))).toBe(true);
        expect(store.getDocument({ id: source.metadata.id })).toEqual(source);
      } finally { await client.dispose(); await server.close(); }
    });

  it('ranks a verified workstream above a weaker semantic parent', async () => {
    const { server, client } = await setup();
    try {
      const destination = store.createDocument({ kind: 'Workstream', spec: { title: 'INC-42' } });
      const other = store.createDocument({ kind: 'Workstream', spec: { title: 'Other destination' } });
      store.createDocument({ kind: 'Topic', spec: { title: 'Unrelated parent', workstreams: [other.metadata.id] } });
      const source = store.createDocument({ kind: 'Topic', spec: { title: 'Re: INC-42' } });
      store.db.prepare('INSERT INTO instance_embedding_settings VALUES (1, 1, 1, NULL)').run();
      indexAll(id => id === destination.metadata.id ? 1 : 0);
      const response = await client.callTool('wm-topic-suggest-placement', { id: source.metadata.id, limit: 1 });
      if (!response.ok) throw new Error(response.error);
      expect(topicPlacementSchema.parse(response.result)).toMatchObject({
        state: 'ready', suggestions: [{ parent: null, workstream: { id: destination.metadata.id },
          similarity: 0, confidence: { reason: expect.stringContaining('Verified lexical evidence') } }],
      });
      expect(store.getDocument({ id: source.metadata.id })).toEqual(source);
    } finally { await client.dispose(); await server.close(); }
  });

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
      for (let index = 0; index < 60; index++) {
        ineligible.push(store.createDocument({ kind: 'Topic', spec: { title: `Unassigned note ${index}: ${caseId}` } }));
      }
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
