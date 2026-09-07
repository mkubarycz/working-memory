import type { DocumentVM } from '../../../webview-ui/src/lib/types';

export interface DocumentTabsState {
  tabs: DocumentVM[];
  selectedKey: string | null;
}

export function documentTabKey(document: DocumentVM): string {
  const identifier = document.slug ?? ('id' in document ? document.id : document.title);
  return `${document.kind}:${identifier}`;
}

export function openDocumentTab(state: DocumentTabsState, document: DocumentVM): DocumentTabsState {
  const key = documentTabKey(document);
  const index = state.tabs.findIndex((tab) => documentTabKey(tab) === key);
  return {
    tabs: index < 0
      ? [...state.tabs, document]
      : state.tabs.map((tab, candidate) => candidate === index ? document : tab),
    selectedKey: key,
  };
}

export function replaceSelectedTab(state: DocumentTabsState, document: DocumentVM): DocumentTabsState {
  if (!state.selectedKey) return openDocumentTab(state, document);
  const index = state.tabs.findIndex((tab) => documentTabKey(tab) === state.selectedKey);
  if (index < 0) return openDocumentTab(state, document);
  const nextKey = documentTabKey(document);
  return {
    tabs: state.tabs.map((tab, candidate) => candidate === index ? document : tab),
    selectedKey: nextKey,
  };
}

export function updateDocumentTab(
  state: DocumentTabsState,
  key: string,
  document: DocumentVM,
): DocumentTabsState {
  const index = state.tabs.findIndex((tab) => documentTabKey(tab) === key);
  if (index < 0) return state;
  const nextKey = documentTabKey(document);
  return {
    tabs: state.tabs.map((tab, candidate) => candidate === index ? document : tab),
    selectedKey: state.selectedKey === key ? nextKey : state.selectedKey,
  };
}

export function closeDocumentTab(state: DocumentTabsState, key: string): DocumentTabsState {
  const index = state.tabs.findIndex((tab) => documentTabKey(tab) === key);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => documentTabKey(tab) !== key);
  if (state.selectedKey !== key) return { ...state, tabs };
  const fallback = tabs[Math.min(index, tabs.length - 1)];
  return { tabs, selectedKey: fallback ? documentTabKey(fallback) : null };
}