import { describe, it, expect } from 'vitest';
import { openStore, ConflictError, NotFoundError } from '../src/store';

// node:sqlite requires Node >= 22.5 (and sometimes --experimental-sqlite).
// Skip rather than hard-fail on runtimes that lack it (mirrors store.test.ts).
let sqliteAvailable = true;
try {
  await import('node:sqlite');
} catch {
  sqliteAvailable = false;
}

(sqliteAvailable ? describe : describe.skip)('store updateDocument (CAS)', () => {
  it('updates spec with the correct expected version, bumping version + updatedAt', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({ kind: 'topic', spec: { title: 'Before' } });
      expect(created.metadata.resourceVersion).toBe(1);

      // Force a later timestamp so the updatedAt bump is observable.
      store.db
        .prepare('UPDATE resources SET updated_at = updated_at - 100 WHERE id = ?')
        .run(created.metadata.id);
      const staleTime = store.getDocument({ id: created.metadata.id })!.metadata.updatedAt;

      const updated = store.updateDocument({
        id: created.metadata.id,
        expectedResourceVersion: created.metadata.resourceVersion,
        spec: { title: 'After' },
      });

      expect(updated.spec).toEqual({ title: 'After' });
      expect(updated.metadata.resourceVersion).toBe(2);
      expect(updated.metadata.updatedAt).toBeGreaterThan(staleTime);
      expect(updated.metadata.id).toBe(created.metadata.id);

      // Persisted to the DB.
      const fetched = store.getDocument({ id: created.metadata.id });
      expect(fetched?.spec).toEqual({ title: 'After' });
      expect(fetched?.metadata.resourceVersion).toBe(2);
    } finally {
      store.close();
    }
  });

  it('optionally writes status when provided (controller path)', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({ kind: 'topic', spec: { title: 'X' }, status: {} });
      const updated = store.updateDocument({
        id: created.metadata.id,
        expectedResourceVersion: created.metadata.resourceVersion,
        spec: { title: 'X' },
        status: { phase: 'Ready' },
      });
      expect(updated.status).toEqual({ phase: 'Ready' });
    } finally {
      store.close();
    }
  });

  it('sets slug and labels when provided and bumps the version', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({
        kind: 'topic',
        slug: 'old-slug',
        labels: { keep: 'me' },
        spec: { title: 'X' },
      });
      const updated = store.updateDocument({
        id: created.metadata.id,
        expectedResourceVersion: created.metadata.resourceVersion,
        spec: { title: 'X' },
        slug: 'new-slug',
        labels: { a: 'b' },
      });
      expect(updated.metadata.slug).toBe('new-slug');
      expect(updated.metadata.labels).toEqual({ a: 'b' });
      expect(updated.metadata.resourceVersion).toBe(2);

      const fetched = store.getDocument({ id: created.metadata.id });
      expect(fetched?.metadata.slug).toBe('new-slug');
      expect(fetched?.metadata.labels).toEqual({ a: 'b' });
    } finally {
      store.close();
    }
  });

  it('leaves slug and labels unchanged when omitted (spec-only update)', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({
        kind: 'topic',
        slug: 'keep-slug',
        labels: { keep: 'me' },
        spec: { title: 'Before' },
      });
      const updated = store.updateDocument({
        id: created.metadata.id,
        expectedResourceVersion: created.metadata.resourceVersion,
        spec: { title: 'After' },
      });
      expect(updated.spec).toEqual({ title: 'After' });
      expect(updated.metadata.slug).toBe('keep-slug');
      expect(updated.metadata.labels).toEqual({ keep: 'me' });
    } finally {
      store.close();
    }
  });

  it('rejects a stale expected version with ConflictError and does not change the row', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({ kind: 'topic', spec: { title: 'Orig' } });
      // First update succeeds, moving the row to version 2.
      store.updateDocument({
        id: created.metadata.id,
        expectedResourceVersion: 1,
        spec: { title: 'First' },
      });

      // Second update using the now-stale version 1 → conflict.
      let thrown: unknown;
      try {
        store.updateDocument({
          id: created.metadata.id,
          expectedResourceVersion: 1,
          spec: { title: 'Second' },
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConflictError);
      expect((thrown as ConflictError).currentResourceVersion).toBe(2);
      expect((thrown as ConflictError).expectedResourceVersion).toBe(1);

      // Row unchanged by the failed write (still 'First', version 2).
      const fetched = store.getDocument({ id: created.metadata.id });
      expect(fetched?.spec).toEqual({ title: 'First' });
      expect(fetched?.metadata.resourceVersion).toBe(2);
    } finally {
      store.close();
    }
  });

  it('throws NotFoundError for an unknown id', () => {
    const store = openStore(':memory:');
    try {
      let thrown: unknown;
      try {
        store.updateDocument({
          id: 'does-not-exist',
          expectedResourceVersion: 1,
          spec: { title: 'x' },
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NotFoundError);
    } finally {
      store.close();
    }
  });

  it('does not update a soft-deleted row (treated as not found)', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({ kind: 'topic', spec: { title: 'Doomed' } });
      // Soft-delete directly through the DB.
      store.db
        .prepare('UPDATE resources SET deleted_at = ? WHERE id = ?')
        .run(1785000000, created.metadata.id);

      let thrown: unknown;
      try {
        store.updateDocument({
          id: created.metadata.id,
          expectedResourceVersion: created.metadata.resourceVersion,
          spec: { title: 'Nope' },
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NotFoundError);

      // Spec untouched on the (still soft-deleted) row.
      const raw = store.db
        .prepare('SELECT spec FROM resources WHERE id = ?')
        .get(created.metadata.id) as unknown as { spec: string };
      expect(JSON.parse(raw.spec)).toEqual({ title: 'Doomed' });
    } finally {
      store.close();
    }
  });
});
