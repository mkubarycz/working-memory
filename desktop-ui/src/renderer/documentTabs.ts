import type { DocumentVM, HostTasksVM } from './documents/types';
import { normalizeScopeKind } from './scopeIdentity';
import { desktopDeepLink } from '../shared/deepLink';

export interface DocumentTabsState {
  tabs: DocumentVM[];
  selectedKey: string | null;
  previewKey?: string | null;
}

export interface PersistedDocumentTabs {
  version: 1;
  tabs: Array<{ kind: string; identifier: string }>;
  selectedKey: string | null;
}

const MAX_PERSISTED_TABS = 50;

export function hostTasksDocument(): HostTasksVM {
  return { kind: 'host-tasks', id: 'approved-host-tasks', title: 'Host tasks' };
}

export function documentTabTooltip(document: DocumentVM, preview = false): string {
  const title = preview
    ? `${document.title} — Preview (double-click to keep open)`
    : document.title;
  return document.kind === 'topic' && document.id
    ? `${title}\n${desktopDeepLink('topic', document.id)}`
    : title;
}

export function documentTabIcon(document: DocumentVM): string {
  switch (document.kind) {
    case 'workstream': return 'briefcase';
    case 'topic': return ('typeMeta' in document ? document.typeMeta?.icon : undefined) ?? 'symbol-misc';
    case 'topic-create': return 'add';
    case 'topic-backlog': return 'inbox';
    case 'container-app': return 'server-environment';
    case 'settings': return 'gear';
    case 'host-tasks': return 'checklist';
    default: return 'file';
  }
}

export function createDocumentOpenGuard() {
  let revision = 0;
  return {
    invalidate() { revision++; },
    capture() {
      const current = revision;
      return () => current === revision;
    },
  };
}

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
  const identifier = document.id ?? ('id' in document ? document.id : undefined) ?? document.title;
  return `${documentRouteKind(document.kind)}:${identifier}`;
}

export function serializeDocumentTabs(state: DocumentTabsState): string {
  const tabs = state.tabs.filter((document) => documentTabKey(document) !== state.previewKey)
    .slice(0, MAX_PERSISTED_TABS);
  return JSON.stringify({
    version: 1,
    tabs: tabs.map((document) => ({
      kind: documentRouteKind(document.kind),
      identifier: document.id ?? ('id' in document ? document.id : undefined) ?? document.title,
    })),
    selectedKey: tabs.some((document) => documentTabKey(document) === canonicalSelectedKey(state.selectedKey))
      ? canonicalSelectedKey(state.selectedKey) : tabs[0] ? documentTabKey(tabs[0]) : null,
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

export function promoteDocumentTab(state: DocumentTabsState, key: string | null): DocumentTabsState {
  return key && state.previewKey === key ? { ...state, previewKey: null } : state;
}

export function promoteOnDocumentInput(node: HTMLElement, promote: () => void) {
  const events = ['beforeinput', 'input', 'change'];
  for (const event of events) node.addEventListener(event, promote, true);
  return {
    destroy() {
      for (const event of events) node.removeEventListener(event, promote, true);
    },
  };
}

export function openDocumentTab(
  state: DocumentTabsState,
  document: DocumentVM,
  preview = true,
): DocumentTabsState {
  const key = documentTabKey(document);
  const index = state.tabs.findIndex((tab) => documentTabKey(tab) === key);
  if (index >= 0) {
    return {
      ...state,
      tabs: state.tabs.map((tab, candidate) => candidate === index ? document : tab),
      selectedKey: key,
      previewKey: !preview && state.previewKey === key ? null : state.previewKey,
    };
  }
  const previewIndex = state.tabs.findIndex((tab) => documentTabKey(tab) === state.previewKey);
  return {
    tabs: preview && previewIndex >= 0
      ? state.tabs.map((tab, candidate) => candidate === previewIndex ? document : tab)
      : [document, ...state.tabs],
    selectedKey: key,
    previewKey: preview ? key : state.previewKey,
  };
}

export function replaceSelectedTab(state: DocumentTabsState, document: DocumentVM): DocumentTabsState {
  if (!state.selectedKey) return openDocumentTab(state, document);
  const index = state.tabs.findIndex((tab) => documentTabKey(tab) === state.selectedKey);
  if (index < 0) return openDocumentTab(state, document);
  return updateDocumentTab(state, state.selectedKey, document);
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
    ...state,
    tabs: state.tabs
      .filter((tab, candidate) => candidate === index || documentTabKey(tab) !== nextKey)
      .map((tab) => documentTabKey(tab) === key ? document : tab),
    selectedKey: state.selectedKey === key ? nextKey : state.selectedKey,
    previewKey: state.previewKey === key
      ? state.tabs.some((tab, candidate) => candidate !== index && documentTabKey(tab) === nextKey)
        ? null : nextKey
      : state.previewKey === nextKey ? null : state.previewKey,
  };
}

export function closeDocumentTab(state: DocumentTabsState, key: string): DocumentTabsState {
  const index = state.tabs.findIndex((tab) => documentTabKey(tab) === key);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => documentTabKey(tab) !== key);
  const previewKey = state.previewKey === key ? null : state.previewKey;
  if (state.selectedKey !== key) return { ...state, tabs, previewKey };
  const fallback = tabs[Math.min(index, tabs.length - 1)];
  return { tabs, selectedKey: fallback ? documentTabKey(fallback) : null, previewKey };
}

export function closeOtherDocumentTabs(state: DocumentTabsState, key: string): DocumentTabsState {
  const tab = state.tabs.find((candidate) => documentTabKey(candidate) === key);
  if (!tab) return state;
  return { tabs: [tab], selectedKey: key, previewKey: state.previewKey === key ? key : null };
}

export function closeDocumentTabsToRight(state: DocumentTabsState, key: string): DocumentTabsState {
  const index = state.tabs.findIndex((tab) => documentTabKey(tab) === key);
  if (index < 0 || index === state.tabs.length - 1) return state;
  const tabs = state.tabs.slice(0, index + 1);
  const selectedKey = tabs.some((tab) => documentTabKey(tab) === state.selectedKey)
    ? state.selectedKey
    : key;
  return {
    tabs, selectedKey,
    previewKey: tabs.some((tab) => documentTabKey(tab) === state.previewKey) ? state.previewKey : null,
  };
}