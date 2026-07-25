import { describe, it, expect } from 'vitest';
import { openStore } from '../src/store';

// node:sqlite requires Node >= 22.5 (and sometimes --experimental-sqlite).
// Skip rather than hard-fail on runtimes that lack it (mirrors store.test.ts).
let sqliteAvailable = true;
try {
  await import('node:sqlite');
} catch {
  sqliteAvailable = false;
}

(sqliteAvailable ? describe : describe.skip)('store documents (resource v1)', () => {
  it('createDocument mints a uuid and increments resource_version 1,2,3', () => {
    const store = openStore(':memory:');
    try {
      const a = store.createDocument({ kind: 'topic' });
      const b = store.createDocument({ kind: 'note' });
      const c = store.createDocument({ kind: 'topic' });

      expect(a.metadata.resourceVersion).toBe(1);
      expect(b.metadata.resourceVersion).toBe(2);
      expect(c.metadata.resourceVersion).toBe(3);
      expect(a.metadata.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(a.metadata.id).not.toBe(b.metadata.id);
    } finally {
      store.close();
    }
  });

  it('defaults slug to null and labels/spec/status to empty objects', () => {
    const store = openStore(':memory:');
    try {
      const d = store.createDocument({ kind: 'topic' });
      expect(d.metadata.slug).toBeNull();
      expect(d.metadata.deletedAt).toBeNull();
      expect(d.metadata.labels).toEqual({});
      expect(d.spec).toEqual({});
      expect(d.status).toEqual({});

      // Round-trips through the DB (JSON columns parse back to objects).
      const fetched = store.getDocument({ id: d.metadata.id });
      expect(fetched?.spec).toEqual({});
      expect(fetched?.status).toEqual({});
      expect(fetched?.metadata.labels).toEqual({});
    } finally {
      store.close();
    }
  });

  it('listDocuments returns non-deleted docs newest-first, with a kind filter', () => {
    const store = openStore(':memory:');
    try {
      store.createDocument({ kind: 'topic', slug: 't1' });
      store.createDocument({ kind: 'note', slug: 'n1' });
      store.createDocument({ kind: 'topic', slug: 't2' });

      const all = store.listDocuments();
      expect(all.map((d) => d.metadata.slug)).toEqual(['t2', 'n1', 't1']);

      const topics = store.listDocuments({ kind: 'topic' });
      expect(topics.map((d) => d.metadata.slug)).toEqual(['t2', 't1']);
      expect(topics.every((d) => d.kind === 'topic')).toBe(true);

      expect(store.listDocuments({ kind: 'nonexistent' })).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('getDocument by id, by slug, and by slug scoped to a kind', () => {
    const store = openStore(':memory:');
    try {
      const created = store.createDocument({
        kind: 'topic',
        slug: 'alpha',
        labels: { area: 'core' },
        spec: { title: 'Alpha' },
      });

      const byId = store.getDocument({ id: created.metadata.id });
      expect(byId?.metadata.slug).toBe('alpha');
      expect(byId?.spec).toEqual({ title: 'Alpha' });
      expect(byId?.metadata.labels).toEqual({ area: 'core' });

      const bySlug = store.getDocument({ slug: 'alpha' });
      expect(bySlug?.metadata.id).toBe(created.metadata.id);

      const bySlugKind = store.getDocument({ slug: 'alpha', kind: 'topic' });
      expect(bySlugKind?.metadata.id).toBe(created.metadata.id);

      // Misses → null.
      expect(store.getDocument({ slug: 'alpha', kind: 'note' })).toBeNull();
      expect(store.getDocument({ id: 'does-not-exist' })).toBeNull();
      expect(store.getDocument({})).toBeNull();
    } finally {
      store.close();
    }
  });
});
