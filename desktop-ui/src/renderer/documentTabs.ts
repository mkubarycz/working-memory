import type { DocumentVM } from './documents/types';
import { normalizeScopeKind } from './scopeIdentity';

export interface DocumentTabsState {
  tabs: DocumentVM[];
  selectedKey: string | null;
}

export interface PersistedDocumentTabs {
  version: 1;
  tabs: Array<{ kind: string; identifier: string }>;
  selectedKey: string | null;
}

const MAX_PERSISTED_TABS = 50;

function documentRouteKind(kind: string): string {
  return normalizeScopeKind(kind) === 'agentmessage' ? 'agent-message' : kind;
}

function canonicalSelectedKey(key: string | null): string | null {
  if (!key) return key;
  const separator = key.indexOf(':');
  return separator < 0 ? key : `${documentRouteKind(key.slice(0, separator))}${key.slice(separator)}`;
}

export function selectedTabScrollLeft(
  scrollLeft: number,
  viewportWidth: number,
  tabLeft: number,
  tabWidth: number,
): number {
  if (tabLeft < scrollLeft) return tabLeft;
  if (tabLeft + tabWidth > scrollLeft + viewportWidth) {
    return Math.max(0, tabLeft + tabWidth - viewportWidth);
  }
  return scrollLeft;
}

export function keepSelectedTabVisible(node: HTMLElement, selected: boolean) {
  let frame = 0;
  const reveal = () => {
    cancelAnimationFrame(frame);
    if (!selected) return;
    frame = requestAnimationFrame(() => {
      const strip = node.parentElement;
      if (!selected || !strip) return;
      const tabLeft = node.getBoundingClientRect().left
        - strip.getBoundingClientRect().left + strip.scrollLeft;
      strip.scrollLeft = selectedTabScrollLeft(
        strip.scrollLeft, strip.clientWidth, tabLeft, node.offsetWidth,
      );
    });
  };
  const observer = new ResizeObserver(reveal);
  const mutations = new MutationObserver(reveal);
  observer.observe(node);
  if (node.parentElement) {
    observer.observe(node.parentElement);
    mutations.observe(node.parentElement, { childList: true });
  }
  reveal();
  return {
    update(value: boolean) {
      selected = value;
      reveal();
    },
    destroy() {
      observer.disconnect();
      mutations.disconnect();
      cancelAnimationFrame(frame);
    },
  };
}

export function documentTabKey(document: DocumentVM): string {
  const identifier = document.slug ?? ('id' in document ? document.id : undefined) ?? document.title;
  return `${documentRouteKind(document.kind)}:${identifier}`;
}

export function serializeDocumentTabs(state: DocumentTabsState): string {
  return JSON.stringify({
    version: 1,
    tabs: state.tabs.slice(0, MAX_PERSISTED_TABS).map((document) => ({
      kind: documentRouteKind(document.kind),
      identifier: document.slug ?? ('id' in document ? document.id : undefined) ?? document.title,
    })),
    selectedKey: canonicalSelectedKey(state.selectedKey),
  } satisfies PersistedDocumentTabs);
}

export function parseDocumentTabs(value: string | null): PersistedDocumentTabs | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<PersistedDocumentTabs>;
    if (
      candidate.version !== 1
      || !Array.isArray(candidate.tabs)
      || candidate.tabs.length > MAX_PERSISTED_TABS
      || (candidate.selectedKey !== null && typeof candidate.selectedKey !== 'string')
    ) return null;
    const tabs: PersistedDocumentTabs['tabs'] = [];
    for (const tab of candidate.tabs) {
      if (
        !tab
        || typeof tab !== 'object'
        || typeof tab.kind !== 'string'
        || !tab.kind.trim()
        || typeof tab.identifier !== 'string'
        || !tab.identifier.trim()
      ) return null;
      tabs.push({ kind: documentRouteKind(tab.kind), identifier: tab.identifier });
    }
    return { version: 1, tabs, selectedKey: canonicalSelectedKey(candidate.selectedKey) };
  } catch {
    return null;
  }
}

export function openDocumentTab(state: DocumentTabsState, document: DocumentVM): DocumentTabsState {
  const key = documentTabKey(document);
  const index = state.tabs.findIndex((tab) => documentTabKey(tab) === key);
  return {
    tabs: index < 0
      ? [document, ...state.tabs]
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

export function closeOtherDocumentTabs(state: DocumentTabsState, key: string): DocumentTabsState {
  const tab = state.tabs.find((candidate) => documentTabKey(candidate) === key);
  if (!tab) return state;
  return { tabs: [tab], selectedKey: key };
}

export function closeDocumentTabsToRight(state: DocumentTabsState, key: string): DocumentTabsState {
  const index = state.tabs.findIndex((tab) => documentTabKey(tab) === key);
  if (index < 0 || index === state.tabs.length - 1) return state;
  const tabs = state.tabs.slice(0, index + 1);
  const selectedKey = tabs.some((tab) => documentTabKey(tab) === state.selectedKey)
    ? state.selectedKey
    : key;
  return { tabs, selectedKey };
}