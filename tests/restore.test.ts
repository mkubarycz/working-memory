import { test, expect } from 'vitest';
import { openJournalStore } from '../src/db';

// ---------------------------------------------------------------------------
// Helper: open a DB and seed a minimal workstream → session → entry chain.
// ---------------------------------------------------------------------------

function seedChain(store: ReturnType<typeof openJournalStore>) {
  const ws = store.createWorkstream({
    slug: 'demo',
    title: 'Demo',
    status: 'open',
  });
  const session = store.startSession({ workstream_slug: 'demo' });
  const e1 = store.appendEntry({
    session_id: session.session_id,
    body: 'first entry',
    created_by: 'test',
  });
  const e2 = store.appendEntry({
    session_id: session.session_id,
    body: 'second entry',
    created_by: 'test',
  });
  return { ws, session, e1, e2 };
}

// ---------------------------------------------------------------------------
// restoreEntry
// ---------------------------------------------------------------------------

test('restoreEntry: soft-deleted entry is restored and visible via getSession', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { session, e1 } = seedChain(store);

  store.softDeleteEntry(e1.id);

  // Confirm it is hidden from normal list
  const beforeRestore = store.listEntriesForSession(session.session_id);
  expect(beforeRestore.find((e) => e.id === e1.id)).toBeUndefined();

  const result = store.restoreEntry(e1.id);
  expect(result.entries).toBe(1);
  expect(result.sessions).toBe(0);
  expect(result.workstreams).toBe(0);

  // Now visible again
  const afterRestore = store.listEntriesForSession(session.session_id);
  const found = afterRestore.find((e) => e.id === e1.id);
  expect(found).toBeDefined();
  expect(found?.deleted_at).toBeNull();

  store.close();
});

test('restoreEntry: restored entry appears in FTS search', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { e1 } = seedChain(store);

  store.softDeleteEntry(e1.id);

  // Should NOT appear in FTS while deleted
  const beforeHits = store.searchEntries({ query: 'first' });
  expect(beforeHits.find((h) => h.id === e1.id)).toBeUndefined();

  store.restoreEntry(e1.id);

  // Should appear in FTS after restore
  const afterHits = store.searchEntries({ query: 'first' });
  expect(afterHits.find((h) => h.id === e1.id)).toBeDefined();

  store.close();
});

test('restoreEntry: throws when entry does not exist or is not deleted', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { e1 } = seedChain(store);

  // Not deleted → throws
  expect(() => store.restoreEntry(e1.id)).toThrow(/not found \(or not deleted\)/i);

  // Non-existent id → throws
  expect(() => store.restoreEntry(99999)).toThrow(/not found \(or not deleted\)/i);

  store.close();
});

// ---------------------------------------------------------------------------
// restoreSession
// ---------------------------------------------------------------------------

test('restoreSession: restores only the session row (entries remain deleted)', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { session } = seedChain(store);

  store.softDeleteSession(session.session_id);

  const result = store.restoreSession(session.session_id);
  expect(result.sessions).toBe(1);
  expect(result.entries).toBe(0);

  // Session visible again
  const restoredSession = store.getSession(session.session_id);
  expect(restoredSession?.deleted_at).toBeNull();

  // Entries remain deleted
  expect(store.listEntriesForSession(session.session_id)).toHaveLength(0);

  store.close();
});

test('restoreSession: no-op when session is already active', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { session } = seedChain(store);

  const result = store.restoreSession(session.session_id);
  expect(result.sessions).toBe(0);
  expect(result.entries).toBe(0);

  store.close();
});

test('restoreSession: throws when session does not exist', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  expect(() => store.restoreSession('no-such-uuid')).toThrow(/session not found/i);

  store.close();
});

// ---------------------------------------------------------------------------
// restoreWorkstream
// ---------------------------------------------------------------------------

test('restoreWorkstream: restores only the workstream row (sessions and entries remain deleted)', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { ws, session } = seedChain(store);

  store.softDeleteWorkstream(ws.slug);

  expect(store.listWorkstreams()).toHaveLength(0);

  const result = store.restoreWorkstream(ws.slug);
  expect(result.workstreams).toBe(1);
  expect(result.sessions).toBe(0);
  expect(result.entries).toBe(0);

  // Workstream visible
  expect(store.listWorkstreams()).toHaveLength(1);

  // Session still soft-deleted
  expect(store.getSession(session.session_id)).toBeNull();
  expect(store.getSession(session.session_id, true)?.deleted_at).not.toBeNull();

  store.close();
});

test('restoreWorkstream: no-op when workstream is already active', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { ws } = seedChain(store);

  const result = store.restoreWorkstream(ws.slug);
  expect(result.workstreams).toBe(0);

  store.close();
});

test('restoreWorkstream: throws when workstream does not exist', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  expect(() => store.restoreWorkstream('no-such-slug')).toThrow(/workstream not found/i);

  store.close();
});

// ---------------------------------------------------------------------------
// restoreTopic
// ---------------------------------------------------------------------------

test('restoreTopic: restores soft-deleted topic (link rows remain deleted)', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const { ws } = seedChain(store);

  store.createTopic({ slug: 'alpha', title: 'Alpha' });
  store.linkWorkstreamTopic({ workstream_slug: ws.slug, topic_slug: 'alpha' });

  store.softDeleteTopic('alpha');

  // Topic hidden from default list
  expect(store.listTopics()).toHaveLength(0);
  expect(store.getTopic('alpha')).toBeNull();

  const result = store.restoreTopic('alpha');
  expect(result.topics).toBe(1);
  expect(result.workstream_links).toBe(0);
  expect(result.entry_links).toBe(0);

  // Topic is visible again
  expect(store.getTopic('alpha')).toBeDefined();
  expect(store.listTopics()).toHaveLength(1);

  store.close();
});

test('restoreTopic: no-op when topic is already active', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  seedChain(store);

  store.createTopic({ slug: 'gamma', title: 'Gamma' });

  const result = store.restoreTopic('gamma');
  expect(result.topics).toBe(0);

  store.close();
});

test('restoreTopic: throws when topic does not exist', () => {
  const store = openJournalStore({ dbPath: ':memory:' });

  expect(() => store.restoreTopic('no-such-topic')).toThrow(/topic not found/i);

  store.close();
});

