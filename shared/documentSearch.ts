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
}

export interface DocumentSearchResult {
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
    || !Array.isArray(value.results) || value.count !== value.results.length) return false;
  return value.results.every((hit: unknown) => hit !== null && typeof hit === 'object'
    && 'id' in hit && typeof hit.id === 'string'
    && 'kind' in hit && typeof hit.kind === 'string'
    && 'title' in hit && typeof hit.title === 'string'
    && 'excerpt' in hit && typeof hit.excerpt === 'string'
    && 'score' in hit && typeof hit.score === 'number' && Number.isFinite(hit.score));
}
