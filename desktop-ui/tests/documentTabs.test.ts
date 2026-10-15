import { describe, expect, it } from 'vitest';
import type { DocumentVM } from '../src/renderer/documents/types';
import {
  closeDocumentTab,
  closeDocumentTabsToRight,
  closeOtherDocumentTabs,
  documentTabKey,
  openDocumentTab,
  replaceSelectedTab,
  updateDocumentTab,
} from '../src/renderer/documentTabs';
import { containerAppDocument } from '../src/renderer/containerApps';

function topic(slug: string, title = slug): DocumentVM {
  return {
    kind: 'topic', title, slug, status: 'open', topicType: 'feature', typeMeta: null,
    body: '', createdAt: 1, updatedAt: 1, resourceVersion: 1, editable: true,
    parents: [], children: [], workstreams: [], focusedWorkstreams: [], alerts: [],
  };
}

describe('document tabs', () => {
  it('appends first-opened documents in order and selects an existing tab without duplication', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'));
    state = openDocumentTab(state, topic('second'));
    state = openDocumentTab(state, topic('first', 'First refreshed'));
    expect(state.tabs.map(documentTabKey)).toEqual(['topic:first', 'topic:second']);
    expect(state.tabs[0]?.title).toBe('First refreshed');
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

    expect(state.tabs.map(documentTabKey)).toEqual(['settings:desktop-settings', 'topic:first']);
    expect(state.selectedKey).toBe('settings:desktop-settings');
    state = openDocumentTab(state, topic('first'));
    expect(state.selectedKey).toBe('topic:first');
    expect(state.tabs.map(documentTabKey)).toContain('settings:desktop-settings');
  });

  it('replaces the selected document in place and closes to the nearest remaining tab', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'));
    state = openDocumentTab(state, topic('second'));
    state = replaceSelectedTab(state, topic('second', 'Second saved'));
    expect(state.tabs.map((tab) => tab.title)).toEqual(['first', 'Second saved']);
    state = closeDocumentTab(state, 'topic:second');
    expect(state.selectedKey).toBe('topic:first');
    expect(closeDocumentTab(state, 'missing')).toBe(state);
  });

  it('updates a background tab without changing the current selection', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'));
    state = openDocumentTab(state, topic('second'));
    state = updateDocumentTab(state, 'topic:first', topic('first', 'First saved'));
    expect(state.tabs[0]?.title).toBe('First saved');
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
});