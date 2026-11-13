import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { LEGACY_ANALYTICS_TABLES, migrateLegacyAnalytics } from '../src/legacyAnalyticsMigration';
import { openStore, type Store } from '../src/store';
import { InstanceIdentity } from '../src/instanceIdentity';
import { InstanceFeatureStore } from '../src/instanceFeatures';
import { ToolQueue } from '../src/toolQueue';
import { HttpDiagnostics } from '../src/diagnostics';
import { DEFAULT_TOOL_QUEUE_SETTINGS } from '../src/diagnosticContract';

const databases: DatabaseSync[] = [], stores = new Set<Store>(), directories: string[] = [];
afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

it('purges only legacy analytics through openStore and preserves documents, credentials, flags and queue settings across reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wm-analytics-migration-'));
  directories.push(directory);
  const filename = join(directory, 'journal.sqlite');
  const first = openStore(filename);
  stores.add(first);
  const document = first.createDocument({ kind: 'Test', spec: { title: 'Keep this', body: '# Authored report\nUnchanged evidence' } });
  const attachment = first.createAttachment({ mimeType: 'text/plain', filename: 'evidence.txt', data: Buffer.from('keep') });
  const owner = await new InstanceIdentity(first.db).initialize('private analytics migration password');
  const features = new InstanceFeatureStore(first.db).write({ search: true, observability: true });
  const queue = new ToolQueue(first.db, () => false);
  const settings = { ...DEFAULT_TOOL_QUEUE_SETTINGS, maxConcurrency: 2 };
  queue.configure(settings, queue.state().settings);
  queue.close();
  const diagnostics = new HttpDiagnostics(first.db, 'test');
  diagnostics.close();
  const marker = first.db.prepare('SELECT * FROM instance_diagnostic_run').get();
  first.db.exec("DELETE FROM resource_migrations WHERE name='legacy-analytics'");
  for (const table of LEGACY_ANALYTICS_TABLES) {
    first.db.exec(`CREATE TABLE "${table}" (value TEXT NOT NULL); INSERT INTO "${table}" VALUES ('old analytics')`);
  }
  first.close();
  stores.delete(first);
  const reopened = openStore(filename);
  stores.add(reopened);
  for (const table of LEGACY_ANALYTICS_TABLES) {
    expect(reopened.db.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table)).toBeUndefined();
  }
  expect(reopened.getDocument({ id: document.metadata.id, kind: 'Test' })).toEqual(document);
  expect(Buffer.from(reopened.getAttachment(attachment.id)!.data).toString()).toBe('keep');
  expect(new InstanceIdentity(reopened.db).authenticate(owner.token)).not.toBeNull();
  expect(new InstanceFeatureStore(reopened.db).read()).toEqual(features);
  const restored = new ToolQueue(reopened.db, () => false);
  expect(restored.state().settings).toEqual(settings);
  restored.close();
  expect(reopened.db.prepare('SELECT * FROM instance_diagnostic_run').get()).toEqual(marker);
  migrateLegacyAnalytics(reopened.db);
  expect(reopened.db.prepare("SELECT version FROM resource_migrations WHERE name='legacy-analytics'").get()).toEqual({ version: 1 });
  expect(reopened.getDocument({ id: document.metadata.id, kind: 'Test' })).toEqual(document);
});

it('rejects unsupported migration versions without deleting history or leaving a transaction open', () => {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE resource_migrations (name TEXT PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO resource_migrations VALUES ('legacy-analytics',2);
    CREATE TABLE instance_http_minutes (value TEXT);
    INSERT INTO instance_http_minutes VALUES ('unchanged')`);
  expect(() => migrateLegacyAnalytics(db)).toThrow('Unsupported legacy-analytics migration version: 2');
  expect(db.prepare('SELECT * FROM instance_http_minutes').all()).toEqual([{ value: 'unchanged' }]);
  db.exec('BEGIN IMMEDIATE; ROLLBACK');
});

it('rolls back earlier drops and the migration marker if any purge operation fails', () => {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE instance_http_minutes (value TEXT);
    INSERT INTO instance_http_minutes VALUES ('unchanged');
    CREATE VIEW instance_diagnostic_events AS SELECT value FROM instance_http_minutes`);
  expect(() => migrateLegacyAnalytics(db)).toThrow(/view/);
  expect(db.prepare('SELECT * FROM instance_http_minutes').all()).toEqual([{ value: 'unchanged' }]);
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='resource_migrations'").get()).toBeUndefined();
  db.exec('BEGIN IMMEDIATE; ROLLBACK');
});
