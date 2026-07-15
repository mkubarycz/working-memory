import { test, expect } from 'vitest';
import { openJournalStore, type WorkstreamSection } from '../src/db';

// ---------------------------------------------------------------------------
// Manual drag-and-drop ordering of the Active tab
// (feature active-tab-drag-drop-ordering, migration 020).
//
// Covers:
//   - the `position` column + `position-asc` ordering
//   - default-position rules on create (queue/progress top, backlog bottom)
//   - default-position rules on a section-move update
//   - reorderWorkstream fractional positioning (top / bottom / between / empty)
//   - cross-section reorder flipping status
// ---------------------------------------------------------------------------

/** Slugs of the given section in position order (top → bottom). */
function order(
  store: ReturnType<typeof openJournalStore>,
  section: WorkstreamSection,
): string[] {
  return store
    .listWorkstreams({ status: 'active', orderBy: 'position-asc' })
    .filter((w) => {
      const s =
        w.status === 'queue' || w.status === 'backlog' ? w.status : 'progress';
      return s === section;
    })
    .map((w) => w.slug);
}

test('createWorkstream: progress lands at the TOP of its section', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'a', title: 'A' }); // progress
  store.createWorkstream({ slug: 'b', title: 'B' });
  store.createWorkstream({ slug: 'c', title: 'C' });

  // Newest on top: c, b, a.
  expect(order(store, 'progress')).toEqual(['c', 'b', 'a']);
  store.close();
});

test('createWorkstream: queue lands at the TOP', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'a', title: 'A', status: 'queue' });
  store.createWorkstream({ slug: 'b', title: 'B', status: 'queue' });

  expect(order(store, 'queue')).toEqual(['b', 'a']);
  store.close();
});

test('createWorkstream: backlog lands at the BOTTOM', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'a', title: 'A', status: 'backlog' });
  store.createWorkstream({ slug: 'b', title: 'B', status: 'backlog' });

  expect(order(store, 'backlog')).toEqual(['a', 'b']);
  store.close();
});

test('updateWorkstream: moving into queue goes to the TOP', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'a', title: 'A', status: 'queue' });
  store.createWorkstream({ slug: 'b', title: 'B', status: 'queue' });
  store.createWorkstream({ slug: 'mover', title: 'Mover', status: 'progress' });

  store.updateWorkstream('mover', { status: 'queue' });

  expect(order(store, 'queue')).toEqual(['mover', 'b', 'a']);
  store.close();
});

test('updateWorkstream: moving into backlog goes to the BOTTOM', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'a', title: 'A', status: 'backlog' });
  store.createWorkstream({ slug: 'b', title: 'B', status: 'backlog' });
  store.createWorkstream({ slug: 'mover', title: 'Mover', status: 'progress' });

  store.updateWorkstream('mover', { status: 'backlog' });

  expect(order(store, 'backlog')).toEqual(['a', 'b', 'mover']);
  store.close();
});

test('updateWorkstream: promoting Backlog → In Progress lands at the BOTTOM', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'p1', title: 'P1' }); // progress
  store.createWorkstream({ slug: 'p2', title: 'P2' }); // progress, on top: p2, p1
  store.createWorkstream({ slug: 'mover', title: 'Mover', status: 'backlog' });

  // Sending a backlog item to In Progress queues it behind the active work,
  // at the bottom — not the top like a queue promotion or a new item.
  store.updateWorkstream('mover', { status: 'progress' });

  expect(order(store, 'progress')).toEqual(['p2', 'p1', 'mover']);
  store.close();
});

test('updateWorkstream: promoting Queue → In Progress still lands at the TOP', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'p1', title: 'P1' }); // progress
  store.createWorkstream({ slug: 'p2', title: 'P2' }); // progress, on top: p2, p1
  store.createWorkstream({ slug: 'mover', title: 'Mover', status: 'queue' });

  store.updateWorkstream('mover', { status: 'progress' });

  expect(order(store, 'progress')).toEqual(['mover', 'p2', 'p1']);
  store.close();
});

test('updateWorkstream: same-section status change leaves position untouched', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'a', title: 'A' }); // progress
  store.createWorkstream({ slug: 'b', title: 'B' }); // progress, on top
  const before = store.getWorkstreamBySlug('a')?.position;

  // A no-op-ish status set to the same section must not re-slot.
  store.updateWorkstream('a', { status: 'progress' });

  expect(store.getWorkstreamBySlug('a')?.position).toBe(before);
  expect(order(store, 'progress')).toEqual(['b', 'a']);
  store.close();
});

test('reorderWorkstream: between two neighbours takes the midpoint', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  // progress top→bottom after creation: c, b, a
  store.createWorkstream({ slug: 'a', title: 'A' });
  store.createWorkstream({ slug: 'b', title: 'B' });
  store.createWorkstream({ slug: 'c', title: 'C' });

  // Drag c down to sit between b (above) and a (below): b, c, a.
  const moved = store.reorderWorkstream({
    slug: 'c',
    section: 'progress',
    prevSlug: 'b',
    nextSlug: 'a',
  });

  expect(moved).not.toBeNull();
  const b = store.getWorkstreamBySlug('b')!;
  const a = store.getWorkstreamBySlug('a')!;
  expect(moved!.position).toBe((b.position + a.position) / 2);
  expect(order(store, 'progress')).toEqual(['b', 'c', 'a']);
  store.close();
});

test('reorderWorkstream: dropped at the top uses next.position - 1', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'a', title: 'A', status: 'queue' });
  store.createWorkstream({ slug: 'b', title: 'B', status: 'queue' });
  // queue order: b, a. Drag a to the very top (above b).
  const moved = store.reorderWorkstream({
    slug: 'a',
    section: 'queue',
    prevSlug: null,
    nextSlug: 'b',
  });

  const b = store.getWorkstreamBySlug('b')!;
  expect(moved!.position).toBe(b.position - 1);
  expect(order(store, 'queue')).toEqual(['a', 'b']);
  store.close();
});

test('reorderWorkstream: dropped at the bottom uses prev.position + 1', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'a', title: 'A', status: 'backlog' });
  store.createWorkstream({ slug: 'b', title: 'B', status: 'backlog' });
  // backlog order: a, b. Drag a to the very bottom (below b).
  const moved = store.reorderWorkstream({
    slug: 'a',
    section: 'backlog',
    prevSlug: 'b',
    nextSlug: null,
  });

  const b = store.getWorkstreamBySlug('b')!;
  expect(moved!.position).toBe(b.position + 1);
  expect(order(store, 'backlog')).toEqual(['b', 'a']);
  store.close();
});

test('reorderWorkstream: no neighbours (lone item) → position 0', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'solo', title: 'Solo', status: 'queue' });

  const moved = store.reorderWorkstream({
    slug: 'solo',
    section: 'queue',
    prevSlug: null,
    nextSlug: null,
  });

  expect(moved!.position).toBe(0);
  store.close();
});

test('reorderWorkstream: unknown slug is a no-op returning null', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  const moved = store.reorderWorkstream({
    slug: 'nope',
    section: 'progress',
    prevSlug: null,
    nextSlug: null,
  });
  expect(moved).toBeNull();
  store.close();
});

test('reorderWorkstream: cross-section drop flips status to the target section', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'q', title: 'Q', status: 'queue' });
  store.createWorkstream({ slug: 'mover', title: 'Mover', status: 'progress' });

  const moved = store.reorderWorkstream({
    slug: 'mover',
    section: 'queue',
    prevSlug: 'q',
    nextSlug: null,
  });

  expect(moved!.status).toBe('queue');
  expect(order(store, 'queue')).toEqual(['q', 'mover']);
  store.close();
});

test('position-asc ordering is stable and independent of last-activity', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'a', title: 'A' });
  store.createWorkstream({ slug: 'b', title: 'B' });
  store.createWorkstream({ slug: 'c', title: 'C' });
  // progress: c, b, a. Touch `a` (bumps updated_at) — must NOT change order.
  store.updateWorkstream('a', { title: 'A2' });

  expect(order(store, 'progress')).toEqual(['c', 'b', 'a']);
  store.close();
});
