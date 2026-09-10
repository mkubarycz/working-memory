import { describe, expect, it } from 'vitest';
import type { DocumentVM } from '../../webview-ui/src/lib/types';
import {
  closeDocumentTab,
  closeDocumentTabsToRight,
  closeOtherDocumentTabs,
  documentTabKey,
  openDocumentTab,
  replaceSelectedTab,
  updateDocumentTab,
} from '../src/renderer/documentTabs';

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