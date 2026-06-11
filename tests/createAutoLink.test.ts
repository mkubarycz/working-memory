import { test, expect } from 'vitest';
import { openJournalStore } from '../src/db';

function setup() {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'ws-a', title: 'WS A', status: 'open' });
  const session = store.startSession({ workstream_slug: 'ws-a', summary: 'Test session' });
  const entry = store.appendEntry({
    session_id: session.session_id,
    body: 'Test entry',
    created_by: 'test',
  });
  return { store, session, entry };
}

// ---------------------------------------------------------------------------
// wm_create_topic auto-linking
// ---------------------------------------------------------------------------

test('createTopic without link params returns topic and no link fields', () => {
  const { store } = setup();
  const result = store.createTopic({ slug: 'plain-topic', title: 'Plain Topic' });
  expect(result.topic.slug).toBe('plain-topic');
  expect(result.workstream_link).toBeUndefined();
  expect(result.entry_link).toBeUndefined();
  expect(result.parent_links).toBeUndefined();
  store.close();
});

test('createTopic with workstream_slug links to workstream atomically', () => {
  const { store } = setup();
  const result = store.createTopic({
    slug: 'ws-linked',
    title: 'WS Linked',
    workstream_slug: 'ws-a',
  });
  expect(result.topic.slug).toBe('ws-linked');
  expect(result.workstream_link).toBeDefined();
  expect(result.workstream_link!.workstream_slug).toBe('ws-a');
  expect(result.workstream_link!.link_created).toBe(true);
  expect(result.workstream_link!.focused).toBe(0);

  // Verify the link persists in the DB
  const ws = store.getWorkstreamBySlug('ws-a')!;
  const wsTopics = store.listTopicsForWorkstream(ws.id);
  expect(wsTopics.some((t) => t.slug === 'ws-linked')).toBe(true);
  store.close();
});

test('createTopic with workstream_slug and focused: true sets focused = 1', () => {
  const { store } = setup();
  const result = store.createTopic({
    slug: 'focused-topic',
    title: 'Focused',
    workstream_slug: 'ws-a',
    focused: true,
  });
  expect(result.workstream_link!.focused).toBe(1);

  const ws = store.getWorkstreamBySlug('ws-a')!;
  const wsTopics = store.listTopicsForWorkstream(ws.id);
  const linked = wsTopics.find((t) => t.slug === 'focused-topic');
  expect(linked?.focused).toBe(1);
  store.close();
});

test('createTopic with entry_id links entry and auto-links its workstream', () => {
  const { store, entry } = setup();
  const result = store.createTopic({
    slug: 'entry-linked',
    title: 'Entry Linked',
    entry_id: entry.id,
  });
  expect(result.entry_link).toBeDefined();
  expect(result.entry_link!.entry_id).toBe(entry.id);
  expect(result.entry_link!.entry_link_created).toBe(true);
  expect(result.entry_link!.workstream_slug).toBe('ws-a');
  expect(result.entry_link!.workstream_link_created).toBe(true);

  // Verify the link persists
  const ws = store.getWorkstreamBySlug('ws-a')!;
  const wsTopics = store.listTopicsForWorkstream(ws.id);
  expect(wsTopics.some((t) => t.slug === 'entry-linked')).toBe(true);
  store.close();
});

test('createTopic with single parent_slug links parent', () => {
  const { store } = setup();
  store.createTopic({ slug: 'parent-topic', title: 'Parent' });
  const result = store.createTopic({
    slug: 'child-topic',
    title: 'Child',
    parent_slug: 'parent-topic',
  });
  expect(result.parent_links).toHaveLength(1);
  expect(result.parent_links![0].parent_slug).toBe('parent-topic');
  expect(result.parent_links![0].link_created).toBe(true);

  const parents = store.listTopicParents('child-topic');
  expect(parents.some((p) => p.slug === 'parent-topic')).toBe(true);
  store.close();
});

test('createTopic with array parent_slug links multiple parents', () => {
  const { store } = setup();
  store.createTopic({ slug: 'par-1', title: 'Parent 1' });
  store.createTopic({ slug: 'par-2', title: 'Parent 2' });
  const result = store.createTopic({
    slug: 'multi-child',
    title: 'Multi Child',
    parent_slug: ['par-1', 'par-2'],
  });
  expect(result.parent_links).toHaveLength(2);
  const parents = store.listTopicParents('multi-child');
  expect(parents).toHaveLength(2);
  store.close();
});

test('createTopic deduplicates repeated parent slugs', () => {
  const { store } = setup();
  store.createTopic({ slug: 'dedup-par', title: 'Dedup Parent' });
  const result = store.createTopic({
    slug: 'dedup-child',
    title: 'Dedup Child',
    parent_slug: ['dedup-par', 'dedup-par'],
  });
  // Should only insert one parent link
  expect(result.parent_links).toHaveLength(1);
  const parents = store.listTopicParents('dedup-child');
  expect(parents).toHaveLength(1);
  store.close();
});

test('createTopic with all link params wires everything atomically', () => {
  const { store, entry } = setup();
  store.createTopic({ slug: 'grand-par', title: 'Grand Parent' });
  const result = store.createTopic({
    slug: 'all-linked',
    title: 'All Linked',
    workstream_slug: 'ws-a',
    focused: true,
    entry_id: entry.id,
    parent_slug: 'grand-par',
  });
  expect(result.topic.slug).toBe('all-linked');
  expect(result.workstream_link!.workstream_slug).toBe('ws-a');
  expect(result.workstream_link!.focused).toBe(1);
  expect(result.entry_link!.entry_id).toBe(entry.id);
  expect(result.parent_links).toHaveLength(1);
  expect(result.parent_links![0].parent_slug).toBe('grand-par');
  store.close();
});

test('createTopic rolls back entirely if workstream_slug is invalid', () => {
  const { store } = setup();
  expect(() =>
    store.createTopic({ slug: 'fail-topic', workstream_slug: 'no-such-ws' }),
  ).toThrow(/workstream not found/i);
  // Topic should NOT have been created
  expect(store.getTopic('fail-topic')).toBeNull();
  store.close();
});

test('createTopic rolls back entirely if parent_slug is invalid', () => {
  const { store } = setup();
  expect(() =>
    store.createTopic({ slug: 'fail-par', parent_slug: 'no-such-parent' }),
  ).toThrow(/parent topic not found/i);
  expect(store.getTopic('fail-par')).toBeNull();
  store.close();
});

test('createTopic rejects self-link in parent_slug', () => {
  const { store } = setup();
  expect(() =>
    store.createTopic({ slug: 'self-ref', parent_slug: 'self-ref' }),
  ).toThrow(/cannot link a topic to itself/i);
  expect(store.getTopic('self-ref')).toBeNull();
  store.close();
});

// ---------------------------------------------------------------------------
// wm_create_workstream auto-linking
// ---------------------------------------------------------------------------

test('createWorkstream without topic_slug returns workstream with no topic_link', () => {
  const { store } = setup();
  const result = store.createWorkstream({ slug: 'plain-ws', title: 'Plain WS' });
  expect(result.workstream.slug).toBe('plain-ws');
  expect(result.topic_link).toBeUndefined();
  store.close();
});

test('createWorkstream with topic_slug links topic to workstream atomically', () => {
  const { store } = setup();
  store.createTopic({ slug: 'ws2-topic', title: 'WS2 Topic' });
  const result = store.createWorkstream({
    slug: 'ws-2',
    title: 'WS 2',
    topic_slug: 'ws2-topic',
  });
  expect(result.workstream.slug).toBe('ws-2');
  expect(result.topic_link).toBeDefined();
  expect(result.topic_link!.topic_slug).toBe('ws2-topic');
  expect(result.topic_link!.link_created).toBe(true);
  expect(result.topic_link!.focused).toBe(0);

  const ws = store.getWorkstreamBySlug('ws-2')!;
  const wsTopics = store.listTopicsForWorkstream(ws.id);
  expect(wsTopics.some((t) => t.slug === 'ws2-topic')).toBe(true);
  store.close();
});

test('createWorkstream with topic_slug and focused: true sets focused = 1', () => {
  const { store } = setup();
  store.createTopic({ slug: 'foc-t', title: 'Focus T' });
  const result = store.createWorkstream({
    slug: 'foc-ws2',
    title: 'Focused WS',
    topic_slug: 'foc-t',
    focused: true,
  });
  expect(result.topic_link!.focused).toBe(1);

  const ws = store.getWorkstreamBySlug('foc-ws2')!;
  const wsTopics = store.listTopicsForWorkstream(ws.id);
  const linked = wsTopics.find((t) => t.slug === 'foc-t');
  expect(linked?.focused).toBe(1);
  store.close();
});

test('createWorkstream rolls back entirely if topic_slug is invalid', () => {
  const { store } = setup();
  expect(() =>
    store.createWorkstream({ slug: 'fail-ws', title: 'Fail WS', topic_slug: 'no-such-topic' }),
  ).toThrow(/topic not found/i);
  // Workstream should NOT have been created
  expect(store.getWorkstreamBySlug('fail-ws')).toBeNull();
  store.close();
});
