import type { Store, DocumentEnvelope } from './store.js';
import { EMBEDDING_MODEL, EMBEDDING_TEXT_LIMIT, matchConfidence } from './embeddingContract.js';
import { HYBRID_CANDIDATE_LIMIT, hybridRanks, lexicalCandidates, lexicalConfidence, refreshDocumentSearch } from './documentSearch.js';
import { similarity, vector } from './topicEmbeddings.js';
import { validateSpec } from './kinds/registry.js';
import { stringArray } from './kinds/topic/topic.js';
import { topicPlacementInputSchema, topicPlacementApplySchema, type TopicPlacement, type TopicPlacementSuggestion } from './topicPlacementContract.js';

function forbiddenParents(store: Store, id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const row of store.db.prepare(`SELECT r.id, p.value AS parent FROM resources r,
    json_each(r.spec, '$.parents') p WHERE r.kind = 'Topic' AND r.deleted_at IS NULL`).iterate()) {
    const parent = String(row.parent);
    const siblings = children.get(parent);
    if (siblings) siblings.push(String(row.id));
    else children.set(parent, [String(row.id)]);
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
  const source = vector(indexed.centroid);
  const forbidden = forbiddenParents(store, input.id);
  const suggestions: Array<Omit<TopicPlacementSuggestion, 'confidence'> & { limited: boolean }> = [];
  const neighbors = new Map<string, { title: string; similarity: number; parents: string[]; workstreams: string[]; limited: boolean }>();
  const liveWorkstreams = new Map(store.listDocuments({ kind: 'Workstream' })
    .filter(document => document.spec.status !== 'closed').map(document => [document.metadata.id, document]));
  for (const row of store.db.prepare(`SELECT r.id, r.kind, r.resource_version, i.centroid, i.limited,
    s.title, substr(s.body, 1, 600) AS excerpt,
    json_extract(r.spec, '$.status') AS status,
    COALESCE(json_extract(r.spec, '$.workstreams'), '[]') AS workstreams,
    COALESCE(json_extract(r.spec, '$.parents'), '[]') AS parents
    FROM topic_embedding_index i JOIN resources r ON r.id = i.topic_id
    JOIN document_search s ON s.rowid = r.rowid
    WHERE r.kind IN ('Topic', 'Workstream') AND r.deleted_at IS NULL
    AND i.model_id = ? AND i.source_version = r.resource_version`).iterate(EMBEDDING_MODEL)) {
    const id = String(row.id);
    if (row.kind === 'Topic' && forbidden.has(id)) continue;
    const score = similarity(source, vector(row.centroid));
    if (row.kind === 'Topic' && row.status === 'closed') continue;
    const excerpt = String(row.excerpt);
    const limited = !!indexed.limited || !!row.limited;
    if (row.kind === 'Topic') {
      const workstreams = stringArray(JSON.parse(String(row.workstreams)));
      neighbors.set(id, { title: String(row.title), similarity: score,
        parents: stringArray(JSON.parse(String(row.parents))), workstreams, limited });
      for (const workstreamId of workstreams) {
        const workstream = liveWorkstreams.get(workstreamId);
        if (!workstream) continue;
        if (stringArray(topic.spec.parents).includes(id) && stringArray(topic.spec.workstreams).includes(workstreamId)) continue;
        suggestions.push({ parent: { id, title: String(row.title), resourceVersion: Number(row.resource_version) },
          workstream: reference(workstream), similarity: score, limited, excerpt, evidence: 'parent-membership' });
      }
    } else if (liveWorkstreams.has(id) && !stringArray(topic.spec.workstreams).includes(id)) {
      suggestions.push({ parent: null, workstream: reference(liveWorkstreams.get(id)!),
        similarity: score, limited, excerpt, evidence: 'workstream-semantic' });
    }
  }
  const evidenceId = (suggestion: TopicPlacementSuggestion | Omit<TopicPlacementSuggestion, 'confidence'>) =>
    suggestion.parent?.id ?? suggestion.workstream.id;
  const eligible = new Map(suggestions.map(suggestion => [evidenceId(suggestion), suggestion.similarity]));
  const lexical = lexicalCandidates(store.db, new Set(eligible.keys()), { sourceId: input.id });
  const ranks = hybridRanks(eligible, lexical);
  const neighborLexical = new Map([...lexical].filter(([id]) => neighbors.has(id)));
  const neighborRanks = hybridRanks(new Map([...neighbors].map(([id, neighbor]) => [id, neighbor.similarity])), neighborLexical);
  const pairKey = (parent: string, workstream: string) => JSON.stringify([parent, workstream]);
  const pairs = new Set(suggestions.filter(s => s.parent).map(s => pairKey(s.parent!.id, s.workstream.id)));
  const support = new Map<string, { weight: number; examples: Array<{ id: string; title: string }>; strong: number; limited: boolean }>();
  let totalWeight = 0, organized = 0;
  for (const [id] of [...neighborRanks].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, HYBRID_CANDIDATE_LIMIT)) {
    const neighbor = neighbors.get(id)!;
    const destinations = new Set(neighbor.parents.flatMap(parent => neighbor.workstreams
      .map(workstream => pairKey(parent, workstream)).filter(key => pairs.has(key))));
    if (!destinations.size) continue;
    // Each authored example has one vote budget, divided across its eligible pairs.
    const weight = neighborLexical.has(id) ? 1 : neighbor.similarity;
    totalWeight += weight;
    organized++;
    for (const key of destinations) {
      const evidence = support.get(key) ?? { weight: 0, examples: [], strong: 0, limited: false };
      evidence.weight += weight / destinations.size;
      evidence.examples.push({ id, title: neighbor.title });
      evidence.strong += Number(neighbor.similarity >= 0.65);
      evidence.limited ||= neighbor.limited;
      support.set(key, evidence);
    }
  }
  const maxDirectRank = Math.max(0, ...ranks.values());
  const structural = (suggestion: typeof suggestions[number]) =>
    suggestion.parent ? support.get(pairKey(suggestion.parent.id, suggestion.workstream.id)) : undefined;
  const placementRank = (suggestion: typeof suggestions[number]) => {
    const direct = (ranks.get(evidenceId(suggestion)) ?? 0) / (maxDirectRank || 1);
    const weight = structural(suggestion)?.weight ?? 0;
    // Agreement discounts conflicting or ambiguous votes; these are ranking units, not probabilities.
    return direct + (totalWeight ? weight * weight / totalWeight : 0);
  };
  const ranked = suggestions.filter(suggestion => ranks.has(evidenceId(suggestion)) || structural(suggestion));
  ranked.sort((a, b) => placementRank(b) - placementRank(a)
    || Number(b.parent !== null) - Number(a.parent !== null)
    || (a.parent?.id ?? '').localeCompare(b.parent?.id ?? '') || a.workstream.id.localeCompare(b.workstream.id));
  const selected = ranked.slice(0, input.limit).map(candidate => {
    const { limited, ...suggestion } = candidate;
    const literal = lexical.get(evidenceId(suggestion));
    let excerpt = literal?.excerpt ?? suggestion.excerpt, passageScore = -1;
    for (const passage of store.db.prepare('SELECT excerpt, vector FROM topic_embedding_passages WHERE topic_id = ?').iterate(evidenceId(suggestion))) {
      const score = similarity(source, vector(passage.vector));
      if (score > passageScore) { passageScore = score; if (!literal) excerpt = String(passage.excerpt); }
    }
    const evidence = structural(candidate);
    const directConfidence = literal ? lexicalConfidence(literal) : matchConfidence(passageScore, suggestion.similarity, false, limited);
    const confidence = evidence ? {
      level: evidence.strong >= 2 && evidence.weight === totalWeight && !evidence.limited ? 'medium' as const : 'low' as const,
      reason: `Authored neighborhood support: ${evidence.examples.length} of ${organized} similar organized topics support this parent/workstream pair. `
        + `Weighted support: ${evidence.weight.toFixed(2)} of ${totalWeight.toFixed(2)} organized vote weight. `
        + `Votes are similarity-weighted (verified lexical matches have unit weight), split across eligible authored pairs, and discounted by disagreement. `
        + `Examples: ${evidence.examples.slice(0, 3).map(example => `${JSON.stringify(example.title)} (${example.id})`).join(', ')}. `
        + `This is structural evidence, not a probability or routing instruction. Similarity and excerpt describe the proposed parent, not these examples. `
        + `Direct evidence: ${directConfidence.reason}`,
    } : directConfidence;
    return { ...suggestion, excerpt, confidence };
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
