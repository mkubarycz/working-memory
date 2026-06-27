import { test, expect, vi } from 'vitest';
import { openJournalStore } from '../src/db';
import { getAllPanelData, getPanelData } from '../src/panelData';
import { TRAVERSAL_MODES } from '../src/graphTraversals';
import { activeWorkstreams } from './helpers';

test('a workstream with a linked topic and entries appears correctly in panel data', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  // arrange
  store.createWorkstream({ slug: 'demo-ws', title: 'Demo WS', status: 'open' });
  store.createTopic({
    slug: 'demo-topic',
    title: 'Demo Topic',
    topic_type: 'feature',
  });
  store.linkWorkstreamTopic({
    workstream_slug: 'demo-ws',
    topic_slug: 'demo-topic',
  });

  const session = store.startSession({ workstream_slug: 'demo-ws' });
  store.appendEntry({ session_id: session.session_id, body: 'chat: first', created_by: 'orchestrator' });
  store.appendEntry({
    session_id: session.session_id,
    body: 'decision: second',
    created_by: 'orchestrator',
  });
  store.appendEntry({ session_id: session.session_id, body: 'fact: third', created_by: 'orchestrator' });

  // act
  const { active } = getAllPanelData(store);

  // assert
  const workstreams = activeWorkstreams(active);
  expect(workstreams).toHaveLength(1);

  const ws = workstreams[0];
  expect(ws.kind).toBe('workstream');
  expect(ws.label).toBe('Demo WS');
  if (ws.kind !== 'workstream') {
    throw new Error('expected workstream item');
  }
  expect(ws.recentEntryCount).toBeGreaterThanOrEqual(0);

  const topicsGroup = ws.children.find((c) => c.kind === 'topics-group');
  expect(topicsGroup).toBeDefined();
  expect(topicsGroup?.children).toHaveLength(1);
  expect(topicsGroup?.children[0].label).toBe('Demo Topic');
  expect(topicsGroup?.children[0].recentEntryCount).toBeGreaterThanOrEqual(0);

  const sessionsGroup = ws.children.find((c) => c.kind === 'sessions-group');
  expect(sessionsGroup).toBeDefined();
  expect(sessionsGroup?.children).toHaveLength(1);
  expect(sessionsGroup?.children[0].description).toContain('3 entries');
  expect(sessionsGroup?.children[0].recentEntryCount).toBeGreaterThanOrEqual(0);

  const topicTab = getAllPanelData(store).topics;
  expect(topicTab.items).toHaveLength(1);
  const topicRow = topicTab.items[0];
  expect(topicRow.kind).toBe('topic-row');
  if (topicRow.kind !== 'topic-row') {
    throw new Error('expected topic-row item');
  }
  expect(topicRow.recentEntryCount).toBeGreaterThanOrEqual(0);

  store.close();
});

test('entry-count chips use total journal entries per workstream/topic/session scope', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const now = Math.floor(Date.now() / 1000);

  store.createWorkstream({ slug: 'ws', title: 'WS', status: 'open' });
  store.createTopic({
    slug: 'top',
    title: 'Top',
    topic_type: 'feature',
  });
  store.linkWorkstreamTopic({ workstream_slug: 'ws', topic_slug: 'top' });

  const s1 = store.startSession({ workstream_slug: 'ws' });
  const s2 = store.startSession({ workstream_slug: 'ws' });

  const s1Recent = store.appendEntry({
    session_id: s1.session_id,
    body: 'recent s1',
    timestamp: now - 60,
    created_by: 'orchestrator',
  });
  const s1Old = store.appendEntry({
    session_id: s1.session_id,
    body: 'old s1',
    timestamp: now - 601,
    created_by: 'orchestrator',
  });
  store.appendEntry({
    session_id: s2.session_id,
    body: 'recent s2',
    timestamp: now - 10,
    created_by: 'orchestrator',
  });

  store.linkEntryTopic({ entry_id: s1Recent.id, topic_slug: 'top' });
  store.linkEntryTopic({ entry_id: s1Old.id, topic_slug: 'top' });

  const all = getAllPanelData(store);
  const activeWs = activeWorkstreams(all.active)[0];
  expect(activeWs.kind).toBe('workstream');
  if (activeWs.kind !== 'workstream') {
    throw new Error('expected workstream item');
  }
  expect(activeWs.recentEntryCount).toBe(3);

  const activeTopicsGroup = activeWs.children.find((c) => c.kind === 'topics-group');
  expect(activeTopicsGroup?.children[0].recentEntryCount).toBe(2);
  const activeSessionsGroup = activeWs.children.find(
    (c) => c.kind === 'sessions-group',
  );
  expect(activeSessionsGroup?.children.map((s) => s.recentEntryCount)).toEqual([2, 1]);

  const topicTabRow = all.topics.items[0];
  expect(topicTabRow.kind).toBe('topic-row');
  if (topicTabRow.kind !== 'topic-row') {
    throw new Error('expected topic-row item');
  }
  expect(topicTabRow.recentEntryCount).toBe(2);

  store.close();
});

test('active tab hides closed sessions; archive tab still shows them', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  // arrange: open workstream + one session
  store.createWorkstream({ slug: 'hide-ws', title: 'Hide WS', status: 'open' });
  const session = store.startSession({ workstream_slug: 'hide-ws' });

  // session is open → should appear on active tab
  const activeBefore = getAllPanelData(store).active;
  const wsBefore = activeWorkstreams(activeBefore)[0];
  expect(wsBefore.kind).toBe('workstream');
  if (wsBefore.kind !== 'workstream') { throw new Error('expected workstream'); }
  const sgBefore = wsBefore.children.find((c) => c.kind === 'sessions-group');
  expect(sgBefore?.children).toHaveLength(1);
  expect(sgBefore?.label).toBe('Sessions (1)');
  expect(sgBefore?.collapsible).toBe(true);

  // close the session
  store.endSession(session.session_id, 'wrap-up');

  // closed session → must NOT appear on active tab
  const activeAfter = getAllPanelData(store).active;
  const wsAfter = activeWorkstreams(activeAfter)[0];
  expect(wsAfter.kind).toBe('workstream');
  if (wsAfter.kind !== 'workstream') { throw new Error('expected workstream'); }
  const sgAfter = wsAfter.children.find((c) => c.kind === 'sessions-group');
  expect(sgAfter?.children).toHaveLength(0);
  expect(sgAfter?.label).toBe('Sessions');
  expect(sgAfter?.description).toBe('none logged');
  expect(sgAfter?.collapsible).toBe(false);

  // close the workstream so it appears on the archive tab
  store.updateWorkstream('hide-ws', { status: 'closed' });

  // closed session MUST still appear on archive tab
  const archiveData = getAllPanelData(store).archive;
  const wsArchive = archiveData.items[0];
  expect(wsArchive.kind).toBe('workstream');
  if (wsArchive.kind !== 'workstream') { throw new Error('expected workstream'); }
  const sgArchive = wsArchive.children.find((c) => c.kind === 'sessions-group');
  expect(sgArchive?.children).toHaveLength(1);
  expect(sgArchive?.label).toBe('Sessions (1)');

  store.close();
});

test('moving a workstream re-stamps updated_at so it sorts newest in the Active recency order', () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const store = openJournalStore({ dbPath: ':memory:' });

    // An older, untouched workstream already sitting in the Queue section.
    store.createWorkstream({
      slug: 'ws-stale',
      title: 'Stale WS',
      status: 'queue',
    });

    // A workstream created LATER (higher id, newer opened_at) that lives in
    // Progress — by creation order it is the newer of the two.
    vi.advanceTimersByTime(60_000);
    store.createWorkstream({
      slug: 'ws-moved',
      title: 'Moved WS',
      status: 'progress',
    });

    // Move it into Queue. This changes only `status` and writes no journal
    // entry, but updateWorkstream re-stamps updated_at = now (the latest of
    // the three workstreams), so it must sort ahead of the older untouched
    // Stale WS within the Queue section.
    vi.advanceTimersByTime(60_000);
    store.updateWorkstream('ws-moved', { status: 'queue' });

    const flattened = activeWorkstreams(getPanelData(store, 'active'));
    const movedIdx = flattened.findIndex((w) => w.label === 'Moved WS');
    const staleIdx = flattened.findIndex((w) => w.label === 'Stale WS');
    expect(movedIdx).toBeGreaterThanOrEqual(0);
    expect(staleIdx).toBeGreaterThanOrEqual(0);
    expect(movedIdx).toBeLessThan(staleIdx);

    store.close();
  } finally {
    vi.useRealTimers();
  }
});

test('topic rows expose graph-aware attach/remove actions', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'ws-actions', title: 'WS Actions', status: 'open' });
  store.createTopic({
    slug: 'topic-actions',
    title: 'Topic Actions',
    topic_type: 'feature',
  });
  store.linkWorkstreamTopic({
    workstream_slug: 'ws-actions',
    topic_slug: 'topic-actions',
  });

  const { active, topics } = getAllPanelData(store);
  const ws = activeWorkstreams(active)[0];
  expect(ws.kind).toBe('workstream');
  if (ws.kind !== 'workstream') {
    throw new Error('expected workstream');
  }
  const activeTopicsGroup = ws.children.find((c) => c.kind === 'topics-group');
  const activeTopic = activeTopicsGroup?.children[0];
  const traversalLabels = Object.values(TRAVERSAL_MODES).map(
    (mode) => {
      switch (mode.id) {
        case 'self':
          return 'Add this topic';
        case 'immediateFamilyOf':
          return 'Add immediate family';
        case 'childrenOf':
          return 'Add children only';
        case 'recursiveFamilyOf':
          return 'Add family tree';
        default:
          return `Add ${mode.label}`;
      }
    },
  );
  expect(activeTopic?.actions?.map((a) => a.title)).toEqual([
    ...traversalLabels,
    'Remove from workstream',
  ]);
  expect(
    activeTopic?.actions?.slice(0, traversalLabels.length).map((a) => a.description),
  ).toEqual(Object.values(TRAVERSAL_MODES).map((mode) => mode.description));
  expect(activeTopic?.actions?.[0]?.args).toEqual([{
    topicSlug: 'topic-actions',
    traversalId: Object.values(TRAVERSAL_MODES)[0]?.id,
    workstreamSlug: 'ws-actions',
  }]);
  expect(activeTopic?.actions?.[traversalLabels.length]?.args).toEqual([{
    topicSlug: 'topic-actions',
    workstreamSlug: 'ws-actions',
  }]);

  const topicRow = topics.items[0];
  expect(topicRow.kind).toBe('topic-row');
  if (topicRow.kind !== 'topic-row') {
    throw new Error('expected topic-row');
  }
  expect(topicRow.actions?.[0]?.args).toEqual([{
    topicSlug: 'topic-actions',
    traversalId: Object.values(TRAVERSAL_MODES)[0]?.id,
  }]);
  expect(topicRow.actions?.[traversalLabels.length]?.args).toEqual([{
    topicSlug: 'topic-actions',
  }]);

  store.close();
});
