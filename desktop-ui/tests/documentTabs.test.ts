import { describe, expect, it, vi } from 'vitest';
import type { DocumentVM, TopicVM } from '../src/renderer/documents/types';
import {
  closeDocumentTab,
  closeDocumentTabsToRight,
  closeOtherDocumentTabs,
  createDocumentOpenGuard,
  documentTabKey,
  documentTabIcon,
  documentTabTooltip,
  hostTasksDocument,
  keepSelectedTabVisible,
  openDocumentTab,
  parseDocumentTabs,
  promoteDocumentTab,
  promoteOnDocumentInput,
  replaceSelectedTab,
  serializeDocumentTabs,
  selectedTabScrollLeft,
  updateDocumentTab,
} from '../src/renderer/documentTabs';
import { containerAppDocument } from '../src/renderer/containerApps';

function topic(id: string, title = id): TopicVM {
  return {
    kind: 'topic', title, id, status: 'open', topicType: 'feature', typeMeta: null,
    body: '', createdAt: 1, updatedAt: 1, resourceVersion: 1, editable: true,
    parents: [], children: [], workstreams: [], focusedWorkstreams: [], agentMessages: [],
  };
}

describe('document tabs', () => {
  it('keeps one permanent host-task tab with a restorable local identity', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, hostTasksDocument(), false);
    state = openDocumentTab(state, topic('preview'));
    state = openDocumentTab(state, hostTasksDocument(), false);
    expect(state.tabs.map(documentTabKey)).toEqual(['topic:preview', 'host-tasks:approved-host-tasks']);
    expect(state.selectedKey).toBe('host-tasks:approved-host-tasks');
    expect(documentTabIcon(hostTasksDocument())).toBe('checklist');
    expect(documentTabTooltip(hostTasksDocument())).toBe('Host tasks');
    expect(parseDocumentTabs(serializeDocumentTabs(state))).toEqual({
      version: 1,
      tabs: [{ kind: 'host-tasks', identifier: 'approved-host-tasks' }],
      selectedKey: 'host-tasks:approved-host-tasks',
    });
    expect(closeDocumentTab(state, 'host-tasks:approved-host-tasks').selectedKey).toBe('topic:preview');
  });

  it('shows topic locators in tab tooltips while retaining the title and preview hint', () => {
    const document = topic('topic-id', 'A readable title');
    expect(documentTabTooltip(document)).toBe('A readable title\nworking-memory://open/topic/topic-id');
    expect(documentTabTooltip(document, true)).toBe(
      'A readable title — Preview (double-click to keep open)\nworking-memory://open/topic/topic-id',
    );
    expect(documentTabTooltip(topic('old id/#'), false))
      .toBe('old id/#\nworking-memory://open/topic/old%20id%2F%23');
    expect(documentTabTooltip(topic('', 'No locator yet'))).toBe('No locator yet');
  });

  it('does not invent topic locators for other document kinds or unsaved drafts', () => {
    const settings: DocumentVM = { kind: 'settings', id: 'desktop-settings', title: 'Settings' };
    expect(documentTabTooltip(settings)).toBe('Settings');
    expect(documentTabTooltip(settings, true)).toBe('Settings — Preview (double-click to keep open)');
    const draft: DocumentVM = {
      kind: 'topic-create', id: 'draft-id', title: 'New topic', body: '', topicType: '',
      topicTypes: [], workstream: '', workstreamTitle: '', parent: null, parentTitle: null,
    };
    expect(documentTabTooltip(draft)).toBe('New topic');
  });

  it('shares topic type icons with message context links without changing tab fallbacks', () => {
    const document = topic('selected');
    expect(documentTabIcon(document)).toBe('symbol-misc');
    expect(documentTabIcon({ ...document, typeMeta: {
      id: 'feature', label: 'Feature', icon: 'rocket', description: '',
    } })).toBe('rocket');
    expect(documentTabIcon(containerAppDocument({ id: 'app', displayName: 'App', icon: 'server-environment' })))
      .toBe('server-environment');
  });

  it('inserts new documents on the left and selects an existing tab without duplication', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'), false);
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

      title: 'Settings',
    };
    let state = openDocumentTab({ tabs: [], selectedKey: null }, settings, false);
    state = openDocumentTab(state, topic('first'), false);
    state = openDocumentTab(state, settings);

    expect(state.tabs.map(documentTabKey)).toEqual(['topic:first', 'settings:desktop-settings']);
    expect(state.selectedKey).toBe('settings:desktop-settings');
    state = openDocumentTab(state, topic('first'));
    expect(state.selectedKey).toBe('topic:first');
    expect(state.tabs.map(documentTabKey)).toContain('settings:desktop-settings');
  });

  it('replaces the selected document in place and closes to the nearest remaining tab', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'), false);
    state = openDocumentTab(state, topic('second'));
    state = replaceSelectedTab(state, topic('second', 'Second saved'));
    expect(state.tabs.map((tab) => tab.title)).toEqual(['Second saved', 'first']);
    state = closeDocumentTab(state, 'topic:second');
    expect(state.selectedKey).toBe('topic:first');
    expect(closeDocumentTab(state, 'missing')).toBe(state);
  });

  it('updates a background tab without changing the current selection', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'), false);
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
      previewKey: null,
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
      previewKey: null,
    });
    expect(closeDocumentTabsToRight({ ...state, selectedKey: 'topic:first' }, 'topic:second')).toEqual({
      tabs: state.tabs.slice(0, 2),
      selectedKey: 'topic:first',
      previewKey: null,
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

  it('replaces only the preview in place, even when a permanent tab is selected', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('kept'), false);
    state = openDocumentTab(state, topic('preview'));
    state = openDocumentTab(state, topic('other-kept'), false);
    state = openDocumentTab(state, topic('next'));
    expect(state.tabs.map(documentTabKey)).toEqual(['topic:other-kept', 'topic:next', 'topic:kept']);
    expect(state.previewKey).toBe('topic:next');
    expect(state.selectedKey).toBe('topic:next');
  });

  it('selects permanent tabs without demotion or consuming an existing preview', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('kept'), false);
    state = openDocumentTab(state, topic('preview'));
    state = openDocumentTab(state, topic('kept'));
    expect(state.tabs.map(documentTabKey)).toEqual(['topic:preview', 'topic:kept']);
    expect(state.previewKey).toBe('topic:preview');
    expect(state.selectedKey).toBe('topic:kept');
  });

  it('promotes idempotently and preserves content, order and selection', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'));
    const tabs = state.tabs;
    expect(promoteDocumentTab(state, 'missing')).toBe(state);
    state = promoteDocumentTab(state, 'topic:first');
    expect(state.tabs).toBe(tabs);
    expect(state.selectedKey).toBe('topic:first');
    expect(state.previewKey).toBeNull();
    expect(promoteDocumentTab(state, 'topic:first')).toBe(state);
    state = openDocumentTab(state, topic('second'));
    expect(state.tabs.map(documentTabKey)).toEqual(['topic:second', 'topic:first']);
  });

  it('refreshes previews without promoting and follows identity changes', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('first'));
    state = updateDocumentTab(state, 'topic:first', topic('first', 'Refreshed'));
    expect(state.previewKey).toBe('topic:first');
    state = replaceSelectedTab(state, topic('renamed'));
    expect(state.previewKey).toBe('topic:renamed');
    expect(state.selectedKey).toBe('topic:renamed');
    state = promoteDocumentTab(state, state.selectedKey);
    state = updateDocumentTab(state, 'topic:renamed', topic('saved'));
    expect(state.previewKey).toBeNull();
    expect(state.selectedKey).toBe('topic:saved');
    expect(updateDocumentTab(state, 'topic:closed', topic('late'))).toBe(state);
  });

  it('deduplicates changed identities without demoting an existing permanent tab', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('existing'), false);
    state = openDocumentTab(state, topic('draft'));
    state = updateDocumentTab(state, 'topic:draft', topic('existing'));
    expect(state.tabs.map(documentTabKey)).toEqual(['topic:existing']);
    expect(state.previewKey).toBeNull();
    expect(state.selectedKey).toBe('topic:existing');
  });

  it('cleans preview identity on close, close others and close to right', () => {
    const state = {
      tabs: [topic('left'), topic('preview'), topic('right')],
      selectedKey: 'topic:preview',
      previewKey: 'topic:preview',
    };
    expect(closeDocumentTab(state, 'topic:preview')).toMatchObject({
      selectedKey: 'topic:right', previewKey: null,
    });
    expect(closeDocumentTab(state, 'topic:left').previewKey).toBe('topic:preview');
    expect(closeOtherDocumentTabs(state, 'topic:left').previewKey).toBeNull();
    expect(closeOtherDocumentTabs(state, 'topic:preview').previewKey).toBe('topic:preview');
    expect(closeDocumentTabsToRight(state, 'topic:left').previewKey).toBeNull();
    expect(closeDocumentTabsToRight(state, 'topic:preview').previewKey).toBe('topic:preview');
  });

  it('persists only permanent tabs and restores legacy identities as permanent', () => {
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('kept'), false);
    state = openDocumentTab(state, topic('temporary'));
    const persisted = parseDocumentTabs(serializeDocumentTabs(state))!;
    expect(persisted).toEqual({
      version: 1, tabs: [{ kind: 'topic', identifier: 'kept' }], selectedKey: 'topic:kept',
    });
    const restored = { tabs: persisted.tabs.map((tab) => topic(tab.identifier)), selectedKey: persisted.selectedKey };
    expect(openDocumentTab(restored, topic('new')).tabs.map(documentTabKey))
      .toEqual(['topic:new', 'topic:kept']);
    expect(parseDocumentTabs(serializeDocumentTabs(openDocumentTab(
      { tabs: [], selectedKey: null }, topic('only-preview'),
    )))).toEqual({ version: 1, tabs: [], selectedKey: null });
    expect(parseDocumentTabs(serializeDocumentTabs(promoteDocumentTab(state, state.previewKey!)))?.tabs)
      .toHaveLength(2);
  });

  it('promotes at capture phase for authored input, not navigation, focus or scrolling', () => {
    const handlers = new Map<string, EventListener>();
    const node = {
      addEventListener: vi.fn((event: string, handler: EventListener) => handlers.set(event, handler)),
      removeEventListener: vi.fn(),
    };
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('draft'));
    const action = promoteOnDocumentInput(node as unknown as HTMLElement, () => {
      state = promoteDocumentTab(state, state.selectedKey);
    });
    expect([...handlers.keys()]).toEqual(['beforeinput', 'input', 'change']);
    expect(node.addEventListener).toHaveBeenCalledWith('beforeinput', expect.any(Function), true);
    expect(state.previewKey).toBe('topic:draft');
    handlers.get('beforeinput')!(new Event('beforeinput'));
    expect(state.previewKey).toBeNull();
    state = openDocumentTab(state, topic('next'));
    expect(state.tabs.map(documentTabKey)).toEqual(['topic:next', 'topic:draft']);
    action.destroy();
    expect(node.removeEventListener).toHaveBeenCalledTimes(3);
  });

  it('ignores out-of-order loads and loads invalidated by selection, close or environment change', async () => {
    const guard = createDocumentOpenGuard();
    let state = openDocumentTab({ tabs: [], selectedKey: null }, topic('initial'));
    let finishFirst!: (document: DocumentVM) => void;
    const firstResult = new Promise<DocumentVM>((resolve) => { finishFirst = resolve; });
    const firstIsCurrent = guard.capture();
    const firstLoad = firstResult.then((document) => {
      if (firstIsCurrent()) state = openDocumentTab(state, document);
    });
    guard.invalidate();
    const secondIsCurrent = guard.capture();
    if (secondIsCurrent()) state = openDocumentTab(state, topic('latest'));
    finishFirst(topic('stale'));
    await firstLoad;
    expect(state.tabs.map(documentTabKey)).toEqual(['topic:latest']);
    for (const _action of ['selection', 'close', 'environment']) {
      const isCurrent = guard.capture();
      guard.invalidate();
      expect(isCurrent()).toBe(false);
    }
  });
});