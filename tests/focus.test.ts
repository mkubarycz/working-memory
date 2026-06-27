import { test, expect } from 'vitest';
import { openJournalStore } from '../src/db';
import { getAllPanelData } from '../src/panelData';
import { activeWorkstreams } from './helpers';

function setup() {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'foc-ws', title: 'Focus WS', status: 'open' });
  store.createTopic({
    slug: 'foc-topic',
    title: 'Focus Topic',
    topic_type: 'feature',
  });
  return store;
}

test('linking with focused: true sets focused = 1 on the workstream_topics row', () => {
  const store = setup();
  const res = store.linkWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic',
    focused: true,
  });
  expect(res.focused).toBe(1);

  const ws = store.getWorkstreamBySlug('foc-ws')!;
  const linked = store.listTopicsForWorkstream(ws.id);
  expect(linked).toHaveLength(1);
  expect(linked[0].focused).toBe(1);

  store.close();
});

test('focused: false clears the flag without removing the link', () => {
  const store = setup();
  store.linkWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic',
    focused: true,
  });
  const cleared = store.linkWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic',
    focused: false,
  });
  expect(cleared.focused).toBe(0);

  const ws = store.getWorkstreamBySlug('foc-ws')!;
  const linked = store.listTopicsForWorkstream(ws.id);
  // Link itself still present, just unfocused.
  expect(linked).toHaveLength(1);
  expect(linked[0].focused).toBe(0);

  store.close();
});

test('omitting focused preserves the existing focused value', () => {
  const store = setup();
  store.linkWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic',
    focused: true,
  });
  // Re-link without specifying focused — should keep the prior value.
  const again = store.linkWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic',
  });
  expect(again.focused).toBe(1);

  store.close();
});

test('focused defaults to 0 for a brand-new link with no explicit focused', () => {
  const store = setup();
  const res = store.linkWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic',
  });
  expect(res.focused).toBe(0);
  store.close();
});

test('panel data surfaces focused on PanelTopic for focused links', () => {
  const store = setup();
  store.linkWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic',
    focused: true,
  });
  // start a session so the workstream shows up under 'active' (last activity)
  store.startSession({ workstream_slug: 'foc-ws' });

  const { active } = getAllPanelData(store);
  const ws = activeWorkstreams(active).find(
    (i) => i.label === 'Focus WS',
  );
  expect(ws).toBeDefined();
  if (!ws || ws.kind !== 'workstream') throw new Error('expected workstream');

  const topicsGroup = ws.children.find((c) => c.kind === 'topics-group');
  expect(topicsGroup?.children).toHaveLength(1);
  expect(topicsGroup?.children[0].focused).toBe(true);

  // focused_topics on the workstream is the quick-access pinned set
  expect(ws.focused_topics).toHaveLength(1);
  expect(ws.focused_topics[0].label).toBe('Focus Topic');
  expect(ws.focused_topics[0].focused).toBe(true);

  // flip it off and re-check
  store.linkWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic',
    focused: false,
  });
  const { active: again } = getAllPanelData(store);
  const ws2 = activeWorkstreams(again).find(
    (i) => i.label === 'Focus WS',
  );
  if (!ws2 || ws2.kind !== 'workstream') throw new Error('expected workstream');
  const tg2 = ws2.children.find((c) => c.kind === 'topics-group');
  expect(tg2?.children[0].focused).toBe(false);
  expect(ws2.focused_topics).toHaveLength(0);

  store.close();
});

test('unfocusWorkstreamTopic clears only the selected focused topic link', () => {
  const store = setup();
  store.createTopic({
    slug: 'foc-topic-2',
    title: 'Focus Topic 2',
    topic_type: 'feature',
  });
  store.linkWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic',
    focused: true,
  });
  store.linkWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic-2',
    focused: true,
  });
  store.startSession({ workstream_slug: 'foc-ws' });

  const cleared = store.unfocusWorkstreamTopic({
    workstream_slug: 'foc-ws',
    topic_slug: 'foc-topic',
  });
  expect(cleared.workstream_slug).toBe('foc-ws');
  expect(cleared.topic_slug).toBe('foc-topic');
  expect(cleared.cleared).toBe(1);

  const ws = store.getWorkstreamBySlug('foc-ws')!;
  const linked = store.listTopicsForWorkstream(ws.id);
  expect(linked).toHaveLength(2);
  const bySlug = new Map(linked.map((topic) => [topic.slug, topic]));
  expect(bySlug.get('foc-topic')?.focused).toBe(0);
  expect(bySlug.get('foc-topic-2')?.focused).toBe(1);

  const { active } = getAllPanelData(store);
  const activeWs = activeWorkstreams(active).find(
    (i) => i.label === 'Focus WS',
  );
  if (!activeWs || activeWs.kind !== 'workstream') {
    throw new Error('expected workstream');
  }
  expect(activeWs.focused_topics).toHaveLength(1);
  expect(activeWs.focused_topics[0].label).toBe('Focus Topic 2');

  store.close();
});
