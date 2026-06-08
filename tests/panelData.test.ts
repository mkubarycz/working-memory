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
  store.appendEntry({ session_id: session.session_id, body: 'chat: first' });
  store.appendEntry({
    session_id: session.session_id,
    body: 'decision: second',
  });
  store.appendEntry({ session_id: session.session_id, body: 'fact: third' });

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

  const topicsGroup = ws.children.find((c) => c.kind === 'topics-group');
  expect(topicsGroup).toBeDefined();
  expect(topicsGroup?.children).toHaveLength(1);
  expect(topicsGroup?.children[0].label).toBe('Demo Topic');

  const sessionsGroup = ws.children.find((c) => c.kind === 'sessions-group');
  expect(sessionsGroup).toBeDefined();
  expect(sessionsGroup?.children).toHaveLength(1);
  expect(sessionsGroup?.children[0].description).toContain('3 entries');

  store.close();
});
