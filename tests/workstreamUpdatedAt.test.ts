import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { openJournalStore } from '../src/db';

// ---------------------------------------------------------------------------
// `updated_at` (last-modified) stamping on every workstream mutation path.
//
// `nowEpoch()` has 1-second resolution, so we drive Date with fake timers and
// advance the clock between mutations to guarantee strictly-greater stamps.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance the fake clock by `seconds` so the next nowEpoch() is larger. */
function tick(seconds: number) {
  vi.advanceTimersByTime(seconds * 1000);
}

test('createWorkstream: updated_at == opened_at at creation', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const ws = store.createWorkstream({ slug: 'demo', title: 'Demo' });

  expect(ws.updated_at).toBe(ws.opened_at);

  store.close();
});

test('updateWorkstream: title change bumps updated_at', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const ws = store.createWorkstream({ slug: 'demo', title: 'Demo' });
  const before = ws.updated_at;

  tick(5);
  const after = store.updateWorkstream('demo', { title: 'Demo Renamed' });

  expect(after.updated_at).toBeGreaterThan(before);

  store.close();
});

test('updateWorkstream: status change bumps updated_at', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const ws = store.createWorkstream({ slug: 'demo', title: 'Demo' });
  const before = ws.updated_at;

  tick(5);
  const after = store.updateWorkstream('demo', { status: 'backlog' });

  expect(after.updated_at).toBeGreaterThan(before);

  store.close();
});

test('updateWorkstream: closure (status -> closed) bumps updated_at and stamps closed_at', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const ws = store.createWorkstream({ slug: 'demo', title: 'Demo' });
  const before = ws.updated_at;

  tick(5);
  const after = store.updateWorkstream('demo', {
    status: 'closed',
    closure: 'wrapped up',
  });

  expect(after.updated_at).toBeGreaterThan(before);
  expect(after.closed_at).not.toBeNull();

  store.close();
});

test('updateWorkstream: true no-op patch does NOT bump updated_at', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const ws = store.createWorkstream({ slug: 'demo', title: 'Demo' });
  const before = ws.updated_at;

  tick(5);
  const after = store.updateWorkstream('demo', {});

  expect(after.updated_at).toBe(before);

  store.close();
});

test('reopenWorkstream: bumps updated_at', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'demo', title: 'Demo', status: 'closed' });
  const closed = store.getWorkstreamBySlug('demo')!;
  const before = closed.updated_at;

  tick(5);
  const after = store.reopenWorkstream('demo');

  expect(after.updated_at).toBeGreaterThan(before);

  store.close();
});

test('softDeleteWorkstream: bumps updated_at alongside deleted_at', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const ws = store.createWorkstream({ slug: 'demo', title: 'Demo' });
  const before = ws.updated_at;

  tick(5);
  store.softDeleteWorkstream('demo');

  const deleted = store.getWorkstreamBySlug('demo', true)!;
  expect(deleted.deleted_at).not.toBeNull();
  expect(deleted.updated_at).toBeGreaterThan(before);

  store.close();
});

test('restoreWorkstream: bumps updated_at', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const ws = store.createWorkstream({ slug: 'demo', title: 'Demo' });

  tick(5);
  store.softDeleteWorkstream('demo');
  const deletedStamp = store.getWorkstreamBySlug('demo', true)!.updated_at;

  tick(5);
  store.restoreWorkstream('demo');

  const restored = store.getWorkstreamBySlug('demo')!;
  expect(restored.deleted_at).toBeNull();
  expect(restored.updated_at).toBeGreaterThan(deletedStamp);
  // sanity: also greater than the original creation stamp
  expect(restored.updated_at).toBeGreaterThan(ws.updated_at);

  store.close();
});
