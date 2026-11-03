import type { SearchContext, SearchResponse, SearchTrace } from '../../../shared/documentSearch';
import type { DocumentVM } from './documents/types';

export interface SearchViewState {
  prompt: string;
  multiline: boolean;
  response: SearchResponse | null;
  loading: boolean;
  error: string;
  notice: string;
  context?: SearchContext;
  requestId: string | null;
  trace: SearchTrace[];
}

export function createSearchViewState(): SearchViewState {
  return { prompt: '', multiline: false, response: null, loading: false, error: '', notice: '', requestId: null, trace: [] };
}

export function searchContextForSession(state: SearchViewState, document: DocumentVM | null): SearchContext | undefined {
  return state.loading || state.prompt.trim() || state.response
    ? state.context : searchContextForDocument(document);
}

export function searchContextForDocument(document: DocumentVM | null): SearchContext | undefined {
  if (!document?.id || ['search', 'settings', 'host-task', 'host-task-create', 'topic-backlog'].includes(document.kind)) return undefined;
  return {
    document: { id: document.id, kind: document.kind, title: document.title },
    ...(document.kind === 'workstream' ? { workstreams: [{ id: document.id, title: document.title }] } : {}),
    ...(document.kind === 'topic' && 'workstreams' in document ? { workstreams: document.workstreams.map(({ id, title }) => ({ id, title })) } : {}),
    ...(document.kind === 'container-app' ? { appId: document.id } : {}),
  };
}
