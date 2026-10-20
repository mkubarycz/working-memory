import { describe, expect, it, vi } from 'vitest';
import type { DocumentVM } from '../src/renderer/documents/types';
import {
  closeDocumentTab,
  closeDocumentTabsToRight,
  closeOtherDocumentTabs,
  documentTabKey,
  keepSelectedTabVisible,
  openDocumentTab,
  parseDocumentTabs,
  replaceSelectedTab,
  serializeDocumentTabs,
  selectedTabScrollLeft,
  updateDocumentTab,
} from '../src/renderer/documentTabs';
import { containerAppDocument } from '../src/renderer/containerApps';

function topic(slug: string, title = slug): DocumentVM {
  return {
    kind: 'topic', title, slug, status: 'open', topicType: 'feature', typeMeta: null,
    body: '', createdAt: 1, updatedAt: 1, resourceVersion: 1, editable: true,
    parents: [], children: [], workstreams: [], focusedWorkstreams: [], alerts: [], alertHistory: [],
  };
}

describe('document tabs', () => {
  it('inserts new documents on the left and selects an existing tab without duplication', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'));
    state = openDocumentTab(state, topic('second'));
    state = openDocumentTab(state, topic('first', 'First refreshed'));
    expect(state.tabs.map(documentTabKey)).toEqual(['topic:second', 'topic:first']);
    expect(state.tabs[1]?.title).toBe('First refreshed');
    expect(state.selectedKey).toBe('topic:first');
  });

  it('uses one stable virtual tab identity for a registered container app', () => {
    const app = { id: 'sunset-chess', displayName: 'Sunset Chess', icon: 'server-environment' };
    let state = openDocumentTab({ tabs: [], selectedKey: null }, containerAppDocument(app));
    state = openDocumentTab(state, containerAppDocument({ ...app, displayName: 'Sunset Chess refreshed' }));
    expect(state.tabs.map(documentTabKey)).toEqual(['container-app:sunset-chess']);
    expect(state.tabs[0]?.title).toBe('Sunset Chess refreshed');
    expect(state.selectedKey).toBe('container-app:sunset-chess');
  });

  it('uses one stable tab identity for the open topic backlog', () => {
    const backlog: DocumentVM = {
      kind: 'topic-backlog',
      id: 'open-topic-backlog',
      slug: null,
      title: 'Open topic backlog',
      topics: [],
    };
    let state = openDocumentTab({ tabs: [], selectedKey: null }, backlog);
    state = openDocumentTab(state, { ...backlog, topics: [{
      kind: 'topic-row',
      id: 'topics:topic:root:orphan',
      label: 'Orphan',
      description: 'Open topic',
      tooltip: 'Orphan',
      icon: 'symbol-key',
      openUri: 'working-memory:/topic/orphan.working-memory',
      status: 'open',
      recentEntryCount: 0,
    }] });
    expect(state.tabs.map(documentTabKey)).toEqual(['topic-backlog:open-topic-backlog']);
    expect(state.tabs[0]?.kind === 'topic-backlog' && state.tabs[0].topics).toHaveLength(1);
  });

  it('keeps one stable Settings tab while selecting topics independently', () => {
    const settings: DocumentVM = {
      kind: 'settings',
      id: 'desktop-settings',
      slug: null,
      title: 'Settings',
    };
    let state = openDocumentTab({ tabs: [], selectedKey: null }, settings);
    state = openDocumentTab(state, topic('first'));
    state = openDocumentTab(state, settings);

    expect(state.tabs.map(documentTabKey)).toEqual(['topic:first', 'settings:desktop-settings']);
    expect(state.selectedKey).toBe('settings:desktop-settings');
    state = openDocumentTab(state, topic('first'));
    expect(state.selectedKey).toBe('topic:first');
    expect(state.tabs.map(documentTabKey)).toContain('settings:desktop-settings');
  });

  it('replaces the selected document in place and closes to the nearest remaining tab', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'));
    state = openDocumentTab(state, topic('second'));
    state = replaceSelectedTab(state, topic('second', 'Second saved'));
    expect(state.tabs.map((tab) => tab.title)).toEqual(['Second saved', 'first']);
    state = closeDocumentTab(state, 'topic:second');
    expect(state.selectedKey).toBe('topic:first');
    expect(closeDocumentTab(state, 'missing')).toBe(state);
  });

  it('updates a background tab without changing the current selection', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'));
    state = openDocumentTab(state, topic('second'));
    state = updateDocumentTab(state, 'topic:first', topic('first', 'First saved'));
    expect(state.tabs[1]?.title).toBe('First saved');
    expect(state.selectedKey).toBe('topic:second');
  });

  it('closes every tab except the context target and selects it', () => {
    const state = {
      tabs: [topic('first'), topic('second'), topic('third')],
      selectedKey: 'topic:first',
    };
    expect(closeOtherDocumentTabs(state, 'topic:second')).toEqual({
      tabs: [state.tabs[1]],
      selectedKey: 'topic:second',
    });
    expect(closeOtherDocumentTabs(state, 'topic:missing')).toBe(state);
  });

  it('reveals the entire selected tab on either edge and after the stage narrows', () => {
    expect(selectedTabScrollLeft(300, 400, 100, 150)).toBe(100);
    expect(selectedTabScrollLeft(0, 400, 450, 150)).toBe(200);
    expect(selectedTabScrollLeft(100, 400, 150, 150)).toBe(100);
    expect(selectedTabScrollLeft(100, 200, 150, 180)).toBe(130);
    expect(selectedTabScrollLeft(200, 400, 0, 150)).toBe(0);
  });
  it('closes tabs to the right and falls back to the context target when selection is removed', () => {
    const state = {
      tabs: [topic('first'), topic('second'), topic('third')],
      selectedKey: 'topic:third',
    };
    expect(closeDocumentTabsToRight(state, 'topic:second')).toEqual({
      tabs: state.tabs.slice(0, 2),
      selectedKey: 'topic:second',
    });
    expect(closeDocumentTabsToRight({ ...state, selectedKey: 'topic:first' }, 'topic:second')).toEqual({
      tabs: state.tabs.slice(0, 2),
      selectedKey: 'topic:first',
    });
    expect(closeDocumentTabsToRight(state, 'topic:third')).toBe(state);
  });

  it('reveals a selected tab again when closing other tabs changes its position', () => {
    let onMutation = () => {};
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect = disconnect;
    });
    vi.stubGlobal('MutationObserver', class {
      constructor(callback: () => void) { onMutation = callback; }
      observe() {}
      disconnect = disconnect;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const strip = { scrollLeft: 0, clientWidth: 400, getBoundingClientRect: () => ({ left: 0 }) };
    let tabLeft = 800;
    const node = {
      parentElement: strip,
      offsetWidth: 150,
      getBoundingClientRect: () => ({ left: tabLeft - strip.scrollLeft }),
    };
    try {
      const action = keepSelectedTabVisible(node as HTMLElement, true);
      expect(strip.scrollLeft).toBe(550);
      tabLeft = 100;
      onMutation();
      expect(strip.scrollLeft).toBe(100);
      action.update(false);
      tabLeft = 800;
      onMutation();
      expect(strip.scrollLeft).toBe(100);
      action.destroy();
      expect(disconnect).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('persists tab identities and selection without storing document bodies', () => {
    const state = {
      tabs: [
        topic('first', 'First'),
        containerAppDocument({ id: 'banking-app', displayName: 'Banking App', icon: 'credit-card' }),
      ],
      selectedKey: 'container-app:banking-app',
    };
    const serialized = serializeDocumentTabs(state);
    expect(serialized).not.toContain('"body"');
    expect(parseDocumentTabs(serialized)).toEqual({
      version: 1,
      tabs: [
        { kind: 'topic', identifier: 'first' },
        { kind: 'container-app', identifier: 'banking-app' },
      ],
      selectedKey: 'container-app:banking-app',
    });
    expect(parseDocumentTabs('{not-json')).toBeNull();
    expect(parseDocumentTabs(JSON.stringify({
      version: 1,
      tabs: [{ kind: '', identifier: 'missing-kind' }],
      selectedKey: null,
    }))).toBeNull();
  });
});