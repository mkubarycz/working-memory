import { semanticSearchTimingsSchema, type MatchConfidence, type SemanticSearchTimings } from '../control-plane/src/embeddingContract';

export interface DocumentSearchInput {
  queries: string[];
  kinds?: string[];
  limit?: number;
}

export interface DocumentSearchHit {
  id: string;
  kind: string;
  title: string;
  excerpt: string;
  score: number;
  similarity?: number;
  resourceVersion?: number;
  literalMatch?: boolean;
  confidence?: MatchConfidence;
}

export interface DocumentSearchResult {
  timings?: SemanticSearchTimings;
  limited?: boolean;
  count: number;
  results: DocumentSearchHit[];
}

export interface ExplainedSearchHit extends DocumentSearchHit {
  reason: string;
  status?: string | null;
  appId?: string;
}

export interface SearchContext {
  document?: { id: string; kind: string; title: string };
  workstreams?: Array<{ id: string; title: string }>;
  appId?: string;
}

export interface SearchOptions {
  requestId: string;
  context?: SearchContext;
}

export type SearchBlock =
  | { type: 'summary'; text: string; sourceIds: string[] }
  | { type: 'list'; heading?: string; items: Array<{ sourceId: string; text: string }> }
  | { type: 'table'; heading?: string; columns: Array<'title' | 'kind' | 'status' | 'summary'>; rows: Array<{ sourceId: string; summary: string }> }
  | { type: 'count'; label: string; value: number; queryId: string }
  | { type: 'clarification'; text: string; suggestions: string[] };

export interface SearchTrace {
  stage?: 'retrieval' | 'ai';
  timings?: SemanticSearchTimings;
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  durationMs: number;
  status: 'success' | 'error';
  count?: number;
  error?: string;
}

export interface SearchResponse {
  query: string;
  queries: string[];
  results: ExplainedSearchHit[];
  blocks?: SearchBlock[];
  trace?: SearchTrace[];
  partial?: boolean;
  limited?: boolean;
}

export interface DocumentQueryInput {
  id?: string;
  kind?: 'Topic' | 'Workstream' | 'AgentMessage' | 'CommandJournal' | 'ContainerClaim' | 'TopicType' | 'Agent';
  query?: string;
  workstream?: string;
  parent?: string;
  topicType?: string;
  status?: string;
  updatedAfter?: number;
  updatedBefore?: number;
  order?: 'updated' | 'title';
  limit?: number;
  offset?: number;
  expectedVersion?: number;
  bodyOffset?: number;
  bodyLimit?: number;
}

export interface QueryDocument {
  id: string;
  kind: string;
  title: string;
  body: string;
  bodyLength: number;
  bodyOffset: number;
  nextBodyOffset: number | null;
  status: string | null;
  workstreams: string[];
  parents: string[];
  createdAt: number;
  updatedAt: number;
  resourceVersion: number;
}

export interface DocumentQueryResult {
  count: number;
  total: number;
  version: number;
  nextOffset: number | null;
  documents: QueryDocument[];
}

export interface SearchWorkstream {
  id: string;
  title: string;
}

export function isDocumentSearchResult(value: unknown): value is DocumentSearchResult {
  if (!value || typeof value !== 'object' || !('count' in value) || !('results' in value)
    || !Array.isArray(value.results) || value.count !== value.results.length
    || 'limited' in value && typeof value.limited !== 'boolean'
    || 'timings' in value && !semanticSearchTimingsSchema.safeParse(value.timings).success) return false;
  return value.results.every((hit: unknown) => hit !== null && typeof hit === 'object'
    && 'id' in hit && typeof hit.id === 'string'
    && 'kind' in hit && typeof hit.kind === 'string'
    && 'title' in hit && typeof hit.title === 'string'
    && 'excerpt' in hit && typeof hit.excerpt === 'string'
    && 'score' in hit && typeof hit.score === 'number' && Number.isFinite(hit.score)
    && (!('similarity' in hit) || typeof hit.similarity === 'number' && Number.isFinite(hit.similarity) && hit.similarity >= -1 && hit.similarity <= 1)
    && (!('resourceVersion' in hit) || typeof hit.resourceVersion === 'number' && Number.isSafeInteger(hit.resourceVersion) && hit.resourceVersion >= 0)
    && (!('literalMatch' in hit) || typeof hit.literalMatch === 'boolean')
    && (!('confidence' in hit) || !!hit.confidence && typeof hit.confidence === 'object'
      && 'level' in hit.confidence && ['high', 'medium', 'low'].includes(String(hit.confidence.level))
      && 'reason' in hit.confidence && typeof hit.confidence.reason === 'string' && hit.confidence.reason.length > 0));
}
