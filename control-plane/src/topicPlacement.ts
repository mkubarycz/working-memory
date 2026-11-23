import type { Store, DocumentEnvelope } from './store.js';
import { EMBEDDING_MODEL, EMBEDDING_TEXT_LIMIT, matchConfidence } from './embeddingContract.js';
import { caseIdentifiers, literalDocumentMatches, refreshDocumentSearch } from './documentSearch.js';
import { similarity, vector } from './topicEmbeddings.js';
import { validateSpec } from './kinds/registry.js';
import { stringArray } from './kinds/topic/topic.js';
import { topicPlacementInputSchema, topicPlacementApplySchema, type TopicPlacement, type TopicPlacementSuggestion } from './topicPlacementContract.js';

function forbiddenParents(store: Store, id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const row of store.db.prepare(`SELECT r.id, p.value AS parent FROM resources r,
    json_each(r.spec, '$.parents') p WHERE r.kind = 'Topic' AND r.deleted_at IS NULL`).iterate()) {
    const parent = String(row.parent);
    children.set(parent, [...children.get(parent) ?? [], String(row.id)]);
  }
  const forbidden = new Set<string>();
  const pending = [id];
  while (pending.length) {
    const current = pending.pop()!;
    if (forbidden.has(current)) continue;
    forbidden.add(current);
    pending.push(...children.get(current) ?? []);
  }
  return forbidden;
}

const reference = (document: DocumentEnvelope) => ({
  id: document.metadata.id, title: String(document.spec.title ?? ''),
  resourceVersion: document.metadata.resourceVersion,
});

export function suggestTopicPlacement(store: Store, raw: unknown, enabled: boolean): TopicPlacement {
  const input = topicPlacementInputSchema.parse(raw);
  const topic = store.getDocument({ id: input.id, kind: 'Topic' });
  if (!topic) throw new Error('That topic is no longer available.');
  const result: TopicPlacement = {
    state: enabled ? 'pending' : 'disabled', sourceVersion: topic.metadata.resourceVersion,
    limited: String(topic.spec.body ?? '').length > EMBEDDING_TEXT_LIMIT, suggestions: [],
  };
  if (!enabled) return result;
  const indexed = store.db.prepare(`SELECT centroid, limited FROM topic_embedding_index
    WHERE topic_id = ? AND model_id = ? AND source_version = ?`)
    .get(input.id, EMBEDDING_MODEL, topic.metadata.resourceVersion);
  if (!indexed) return result;
  // Do not present an incomplete index as an authoritative empty placement result.
  if (store.db.prepare(`SELECT 1 FROM resources r LEFT JOIN topic_embedding_index i ON i.topic_id = r.id
    WHERE r.kind IN ('Topic', 'Workstream') AND r.deleted_at IS NULL
    AND (i.topic_id IS NULL OR i.model_id != ? OR i.source_version != r.resource_version) LIMIT 1`).get(EMBEDDING_MODEL)) return result;
  refreshDocumentSearch(store.db);
  const text = store.db.prepare('SELECT title || char(10) || body AS text FROM document_search WHERE id = ?').get(input.id);
  if (!text) throw new Error('The topic search projection is unavailable. Retry after indexing.');
  const literalMatches = literalDocumentMatches(store.db, caseIdentifiers(String(text.text)), ['Topic']);
  const source = vector(indexed.centroid);
  const forbidden = forbiddenParents(store, input.id);
  const suggestions: Array<Omit<TopicPlacementSuggestion, 'confidence'> & { limited: boolean; literalMatch: boolean }> = [];
  const liveWorkstreams = new Map(store.listDocuments({ kind: 'Workstream' })
    .filter(document => document.spec.status !== 'closed').map(document => [document.metadata.id, document]));
  for (const row of store.db.prepare(`SELECT r.id, r.kind, r.resource_version, i.centroid, i.limited,
    s.title, substr(s.body, 1, 600) AS excerpt,
    json_extract(r.spec, '$.status') AS status,
    COALESCE(json_extract(r.spec, '$.workstreams'), '[]') AS workstreams
    FROM topic_embedding_index i JOIN resources r ON r.id = i.topic_id
    JOIN document_search s ON s.rowid = r.rowid
    WHERE r.kind IN ('Topic', 'Workstream') AND r.deleted_at IS NULL
    AND i.model_id = ? AND i.source_version = r.resource_version`).iterate(EMBEDDING_MODEL)) {
    const id = String(row.id);
    if (row.kind === 'Topic' && forbidden.has(id)) continue;
    const score = similarity(source, vector(row.centroid));
    const literalMatch = literalMatches.has(id);
    if (score < 0.35 && !literalMatch) continue;
    if (row.kind === 'Topic' && row.status === 'closed') continue;
    const excerpt = literalMatches.get(id) ?? String(row.excerpt);
    const limited = !!indexed.limited || !!row.limited;
    if (row.kind === 'Topic') {
      for (const workstreamId of stringArray(JSON.parse(String(row.workstreams)))) {
        const workstream = liveWorkstreams.get(workstreamId);
        if (!workstream) continue;
        if (stringArray(topic.spec.parents).includes(id) && stringArray(topic.spec.workstreams).includes(workstreamId)) continue;
        suggestions.push({ parent: { id, title: String(row.title), resourceVersion: Number(row.resource_version) },
          workstream: reference(workstream), similarity: score, limited, literalMatch, excerpt, evidence: 'parent-membership' });
      }
    } else if (liveWorkstreams.has(id) && !stringArray(topic.spec.workstreams).includes(id)) {
      suggestions.push({ parent: null, workstream: reference(liveWorkstreams.get(id)!),
        similarity: score, limited, literalMatch, excerpt, evidence: 'workstream-semantic' });
    }
  }
  suggestions.sort((a, b) => Number(b.literalMatch) - Number(a.literalMatch)
    || Number(b.parent !== null) - Number(a.parent !== null)
    || b.similarity - a.similarity
    || (a.parent?.id ?? '').localeCompare(b.parent?.id ?? '') || a.workstream.id.localeCompare(b.workstream.id));
  const selected = suggestions.slice(0, input.limit).map(({ limited, literalMatch, ...suggestion }) => {
    let excerpt = suggestion.excerpt, passageScore = -1;
    const evidenceId = suggestion.parent?.id ?? suggestion.workstream.id;
    for (const passage of store.db.prepare('SELECT excerpt, vector FROM topic_embedding_passages WHERE topic_id = ?').iterate(evidenceId)) {
      const score = similarity(source, vector(passage.vector));
      if (score > passageScore) { passageScore = score; if (!literalMatch) excerpt = String(passage.excerpt); }
    }
    return { ...suggestion, excerpt, confidence: matchConfidence(passageScore, suggestion.similarity, literalMatch, limited) };
  });
  return { ...result, state: 'ready', suggestions: selected };
}

export function applyTopicPlacement(store: Store, raw: unknown): DocumentEnvelope {
  const input = topicPlacementApplySchema.parse(raw);
  const topic = store.getDocument({ id: input.id, kind: 'Topic' });
  if (!topic) throw new Error('That topic is no longer available.');
  if (topic.metadata.resourceVersion !== input.expectedResourceVersion) throw new Error('Conflict: the topic changed. Suggest placement again.');
  const workstream = store.getDocument({ id: input.workstream.id, kind: 'Workstream' });
  if (!workstream || workstream.spec.status === 'closed') throw new Error('That workstream is no longer open.');
  if (workstream.metadata.resourceVersion !== input.workstream.resourceVersion) throw new Error('Conflict: the workstream changed. Suggest placement again.');
  const parents = stringArray(topic.spec.parents);
  if (input.parent) {
    const parent = store.getDocument({ id: input.parent.id, kind: 'Topic' });
    if (!parent || parent.spec.status === 'closed') throw new Error('That parent topic is no longer open.');
    if (parent.metadata.resourceVersion !== input.parent.resourceVersion) throw new Error('Conflict: the parent changed. Suggest placement again.');
    if (forbiddenParents(store, input.id).has(input.parent.id)) throw new Error('A topic cannot be its own parent or a descendant’s child.');
    if (!stringArray(parent.spec.workstreams).includes(workstream.metadata.id)) throw new Error('The parent no longer belongs to that workstream.');
    if (!parents.includes(input.parent.id)) parents.push(input.parent.id);
  }
  const workstreams = stringArray(topic.spec.workstreams);
  if (!workstreams.includes(workstream.metadata.id)) workstreams.push(workstream.metadata.id);
  const spec = validateSpec('Topic', { ...topic.spec, parents, workstreams });
  if (JSON.stringify(spec) === JSON.stringify(topic.spec)) return topic;
  return store.updateDocument({ id: input.id, expectedResourceVersion: input.expectedResourceVersion, spec });
}
