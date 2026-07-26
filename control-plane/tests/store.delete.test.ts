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

(sqliteAvailable ? describe : describe.skip)('store deleteDocument / restoreDocument (soft-delete)', () => {
  it('soft-deletes: stamps deleted_at, bumps version, drops out of list + get', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({ kind: 'Topic', spec: { title: 'Doomed' } });
      expect(created.metadata.resourceVersion).toBe(1);
      expect(created.metadata.deletedAt).toBeNull();

      const deleted = store.deleteDocument({ id: created.metadata.id });
      expect(deleted.metadata.id).toBe(created.metadata.id);
      expect(deleted.metadata.deletedAt).not.toBeNull();
      expect(deleted.metadata.resourceVersion).toBe(2); // bumped

      // Vanishes from the live views.
      expect(store.listDocuments()).toHaveLength(0);
      expect(store.getDocument({ id: created.metadata.id })).toBeNull();
    } finally {
      store.close();
    }
  });

  it('is kind-agnostic: deletes a doc created with an UNREGISTERED kind', () => {
    const store = openStore(':memory:');
    try {
      // Legacy lowercase 'topic' is NOT a registered kind — delete must not care.
      const junk = store.createDocument({
        kind: 'topic',
        spec: { hallucinated: 'field', anything: 123 },
      });
      const deleted = store.deleteDocument({ id: junk.metadata.id });
      expect(deleted.kind).toBe('topic');
      expect(deleted.metadata.deletedAt).not.toBeNull();
      expect(store.getDocument({ id: junk.metadata.id })).toBeNull();
    } finally {
      store.close();
    }
  });

  it('throws NotFoundError for an unknown id', () => {
    const store = openStore(':memory:');
    try {
      let thrown: unknown;
      try {
        store.deleteDocument({ id: 'does-not-exist' });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NotFoundError);
    } finally {
      store.close();
    }
  });

  it('throws NotFoundError when deleting an already-deleted doc', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({ kind: 'Topic', spec: { title: 'X' } });
      store.deleteDocument({ id: created.metadata.id });

      let thrown: unknown;
      try {
        store.deleteDocument({ id: created.metadata.id });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(NotFoundError);
    } finally {
      store.close();
    }
  });

  it('CAS: rejects a stale expectedResourceVersion with ConflictError, row unchanged', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({ kind: 'Topic', spec: { title: 'Orig' } });
      // Bump the version once via an update so the created version is stale.
      store.updateDocument({
        id: created.metadata.id,
        expectedResourceVersion: 1,
        spec: { title: 'Updated' },
      });

      let thrown: unknown;
      try {
        store.deleteDocument({ id: created.metadata.id, expectedResourceVersion: 1 });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ConflictError);
      expect((thrown as ConflictError).currentResourceVersion).toBe(2);
      expect((thrown as ConflictError).expectedResourceVersion).toBe(1);

      // Row still live and unchanged by the failed delete.
      const fetched = store.getDocument({ id: created.metadata.id });
      expect(fetched?.metadata.deletedAt).toBeNull();
      expect(fetched?.metadata.resourceVersion).toBe(2);
    } finally {
      store.close();
    }
  });

  it('CAS: deletes when expectedResourceVersion matches the live version', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({ kind: 'Topic', spec: { title: 'X' } });
      const deleted = store.deleteDocument({
        id: created.metadata.id,
        expectedResourceVersion: created.metadata.resourceVersion,
      });
      expect(deleted.metadata.deletedAt).not.toBeNull();
    } finally {
      store.close();
    }
  });

  it('restore round-trips: a restored doc reappears in the list', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({ kind: 'Topic', spec: { title: 'Back' } });
      store.deleteDocument({ id: created.metadata.id });
      expect(store.listDocuments()).toHaveLength(0);

      const restored = store.restoreDocument({ id: created.metadata.id });
      expect(restored.metadata.id).toBe(created.metadata.id);
      expect(restored.metadata.deletedAt).toBeNull();
      expect(restored.metadata.resourceVersion).toBe(3); // create(1) → delete(2) → restore(3)

      expect(store.listDocuments()).toHaveLength(1);
      expect(store.getDocument({ id: created.metadata.id })?.metadata.deletedAt).toBeNull();
    } finally {
      store.close();
    }
  });

  it('restore throws NotFoundError for an unknown id or an already-live doc', () => {
    const store = openStore(':memory:');
    try {
      let thrownUnknown: unknown;
      try {
        store.restoreDocument({ id: 'does-not-exist' });
      } catch (err) {
        thrownUnknown = err;
      }
      expect(thrownUnknown).toBeInstanceOf(NotFoundError);

      const created = store.createDocument({ kind: 'Topic', spec: { title: 'Live' } });
      let thrownLive: unknown;
      try {
        store.restoreDocument({ id: created.metadata.id });
      } catch (err) {
        thrownLive = err;
      }
      expect(thrownLive).toBeInstanceOf(NotFoundError);
    } finally {
      store.close();
    }
  });
});
