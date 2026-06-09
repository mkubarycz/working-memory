import { test, expect } from 'vitest';
import { openJournalStore } from '../src/db';
import { getAllPanelData } from '../src/panelData';

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
  expect(active.items).toHaveLength(1);

  const ws = active.items[0];
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
  const activeWs = all.active.items[0];
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
