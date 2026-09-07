import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ConflictError, openStore } from '../src/store';

// node:sqlite requires Node >= 22.5 (and, on some builds, --experimental-sqlite).
// Detect availability so this suite stays green on runtimes that lack it rather
// than hard-failing. Everything else in the skeleton is sqlite-independent.
let sqliteAvailable = true;
try {
  await import('node:sqlite');
} catch {
  sqliteAvailable = false;
}

(sqliteAvailable ? describe : describe.skip)('openStore', () => {
  it('creates the database file and enables WAL journal mode', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-cp-store-'));
    const file = path.join(dir, 'journal.sqlite');
    const store = openStore(file);
    try {
      expect(fs.existsSync(file)).toBe(true);
      const row = store.db.prepare('PRAGMA journal_mode').get() as
        | { journal_mode?: string }
        | undefined;
      expect(String(row?.journal_mode).toLowerCase()).toBe('wal');
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates missing parent directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-cp-store-'));
    const file = path.join(dir, 'nested', 'deeper', 'journal.sqlite');
    const store = openStore(file);
    try {
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rolls back an entire batch when a later CAS update fails', () => {
    const store = openStore(':memory:');
    try {
      const first = store.createDocument({ kind: 'Test', slug: 'first', spec: { title: 'First' } });
      const second = store.createDocument({ kind: 'Test', slug: 'second', spec: { title: 'Second' } });
      const beforeVersion = store.db
        .prepare("SELECT value FROM store_meta WHERE key = 'resource_version'")
        .get() as unknown as { value: number };

      expect(() => store.updateDocuments([
        {
          id: first.metadata.id,
          expectedResourceVersion: first.metadata.resourceVersion,
          spec: { title: 'Changed' },
        },
        {
          id: second.metadata.id,
          expectedResourceVersion: second.metadata.resourceVersion + 1,
          spec: { title: 'Never written' },
        },
      ])).toThrow(ConflictError);

      expect(store.getDocument({ id: first.metadata.id })?.spec).toEqual({ title: 'First' });
      expect(store.getDocument({ id: second.metadata.id })?.spec).toEqual({ title: 'Second' });
      const afterVersion = store.db
        .prepare("SELECT value FROM store_meta WHERE key = 'resource_version'")
        .get() as unknown as { value: number };
      expect(afterVersion.value).toBe(beforeVersion.value);
    } finally {
      store.close();
    }
  });
});
