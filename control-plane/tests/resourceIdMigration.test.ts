import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrateResourceIds } from '../src/resourceIdMigration';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function legacy() {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE resources (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, slug TEXT,
      spec TEXT NOT NULL, deleted_at INTEGER, resource_version INTEGER NOT NULL,
      labels TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
    );
    CREATE UNIQUE INDEX legacy_resource_names ON resources(kind, slug) WHERE deleted_at IS NULL;
    CREATE TABLE store_meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
    INSERT INTO store_meta VALUES ('resource_version', 10);
    CREATE TABLE children (resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE);
  `);
  return db;
}

function insert(db: DatabaseSync, id: string, kind: string, slug: string | null, spec: object, deletedAt: number | null = null) {
  db.prepare('INSERT INTO resources (id, kind, slug, spec, deleted_at, resource_version) VALUES (?, ?, ?, ?, ?, 10)').run(id, kind, slug, JSON.stringify(spec), deletedAt);
}

function spec(db: DatabaseSync, id: string) {
  return JSON.parse((db.prepare('SELECT spec FROM resources WHERE id = ?').get(id) as { spec: string }).spec);
}

describe('resource-ID migration', () => {
  it('preserves IDs, child rows, authored text, historical source and order while migrating typed references', () => {
    const db = legacy();
    const body = '# Original\r\n[old link](working-memory://open/topic/parent)\n![image](wm-attachment:unchanged)';
    insert(db, 'type-id', 'TopicType', 'task', { label: 'Task' });
    insert(db, 'ws-id', 'Workstream', 'release', { title: 'Release' });
    insert(db, 'parent-id', 'Topic', 'parent', { title: 'Parent', topicType: 'task', workstreams: ['release'] });
    insert(db, 'topic-id', 'Topic', 'child', {
      title: 'Child', body, topicType: 'task', parents: ['parent'], workstreams: ['release'], focusedWorkstreams: ['release'],
    });
    const source = { row: { slug: 'old-message', spec: '{"topics":["child"]}' } };
    insert(db, 'message-id', 'AgentMessage', null, { description: body, topics: ['child'], legacy_source: source, relations: [{ kind: 'Topic', id: 'topic-id' }] });
    db.exec("INSERT INTO children VALUES ('topic-id')");
    const originalOrder = db.prepare('SELECT rowid, id FROM resources ORDER BY rowid').all();
    migrateResourceIds(db);
    expect(spec(db, 'topic-id')).toEqual({
      title: 'Child', body, topicType: 'type-id', parents: ['parent-id'], workstreams: ['ws-id'], focusedWorkstreams: ['ws-id'],
    });
    expect(spec(db, 'message-id')).toMatchObject({ description: body, topics: ['topic-id'], legacy_source: source });
    expect(db.prepare('SELECT rowid, id FROM resources ORDER BY rowid').all()).toEqual(originalOrder);
    expect(db.prepare('SELECT * FROM children').all()).toEqual([{ resource_id: 'topic-id' }]);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA table_info(resources)').all()).not.toContainEqual(expect.objectContaining({ name: 'slug' }));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'legacy_resource_names'").get()).toBeUndefined();
    const migrated = db.prepare('SELECT * FROM resources').all();
    migrateResourceIds(db);
    expect(db.prepare('SELECT * FROM resources').all()).toEqual(migrated);
  });

  it('supports references already stored as IDs and soft-deleted resources', () => {
    const db = legacy();
    insert(db, 'old-id', 'Topic', 'old', { title: 'Old' }, 123);
    insert(db, 'new-id', 'Topic', 'new', { title: 'New', parents: ['old-id'] });
    migrateResourceIds(db);
    expect(spec(db, 'new-id').parents).toEqual(['old-id']);
    expect(db.prepare("SELECT deleted_at FROM resources WHERE id = 'old-id'").get()).toEqual({ deleted_at: 123 });
  });

  it('rolls back missing and ambiguous references instead of dropping or guessing', () => {
    for (const ambiguous of [false, true]) {
      const db = legacy();
      if (ambiguous) {
        insert(db, 'one', 'Topic', 'target', {}, 1);
        insert(db, 'two', 'Topic', 'target', {}, 2);
      }
      insert(db, 'child', 'Topic', 'child', { parents: ['target'] });
      const before = db.prepare('SELECT * FROM resources').all();
      expect(() => migrateResourceIds(db)).toThrow(ambiguous ? /ambiguous/ : /missing/);
      expect(db.prepare('SELECT * FROM resources').all()).toEqual(before);
      expect(db.prepare("SELECT value FROM store_meta WHERE key = 'resource_version'").get()).toEqual({ value: 10 });
      expect(db.prepare('PRAGMA table_info(resources)').all()).toContainEqual(expect.objectContaining({ name: 'slug' }));
    }
  });

  it('rejects a legacy name that collides with a different object ID', () => {
    const db = legacy();
    insert(db, 'one', 'Topic', 'different', {});
    insert(db, 'two', 'Topic', 'one', {});
    insert(db, 'child', 'Topic', 'child', { parents: ['one'] });
    expect(() => migrateResourceIds(db)).toThrow(/ambiguous/);
  });

  it('explicitly repairs authored URLs and broken references, recording a risk-grouped upgrade topic', () => {
    const db = legacy();
    insert(db, 'type-id', 'TopicType', 'topic', { label: 'Topic' });
    insert(db, 'parent-id', 'Topic', 'parent', { title: 'Parent' });
    const source = { row: { spec: '[Historical](vscode://kubarycz.working-memory/open/topic/parent)' } };
    insert(db, 'child-id', 'Topic', 'child', {
      title: 'Child', topicType: 'missing', parents: ['parent', 'absent'],
      body: '[Parent](vscode://kubarycz.working-memory/open/topic/parent)\n[Unknown](working-memory://open/topic/absent)',
      legacy_source: source, status: 'closed',
    });
    insert(db, 'journal', 'CommandJournal', null, {
      schemaVersion: 2, primaryScope: { kind: 'topic', id: 'parent' },
      entityRefs: [{ kind: 'Topic', id: 'parent-id', slug: 'parent', relation: 'referenced' }],
      workstream: 'parent', events: [],
    });
    const result = migrateResourceIds(db, { repairLegacyData: true });
    expect(result.repairedLinks).toBe(1);
    expect(result.issues).toHaveLength(3);
    expect(spec(db, 'child-id')).toMatchObject({
      topicType: 'type-id', parents: ['parent-id'], legacy_source: source, status: 'closed',
      body: '[Parent](working-memory://open/topic/parent-id)\n[Unknown](working-memory://open/topic/absent)',
    });
    expect(spec(db, 'journal')).toMatchObject({
      primaryScope: { kind: 'topic', id: 'parent-id' },
      entityRefs: [{ kind: 'Topic', id: 'parent-id', relation: 'referenced' }], workstream: 'parent-id',
    });
    const report = spec(db, result.reportId!);
    expect(report.body).toContain('## High risk');
    expect(report.body).toContain('## Medium risk');
    expect(report.body).toContain('working-memory://open/document/child-id');
    expect(report.workstreams).toEqual([result.workstreamId]);
    expect(report.status).toBe('open');
    expect(db.prepare("SELECT COUNT(*) AS count FROM resources WHERE kind='Workstream'").get()).toEqual({ count: 1 });
    expect(migrateResourceIds(db, { repairLegacyData: true }).repairedLinks).toBe(0);
  });

  it('dry-runs the complete repair transaction without touching data or schema', () => {
    const db = legacy();
    insert(db, 'type', 'TopicType', 'topic', { label: 'Topic' });
    insert(db, 'child', 'Topic', 'child', { title: 'Child', parents: ['missing'] });
    const before = db.prepare('SELECT * FROM resources').all();
    expect(migrateResourceIds(db, { repairLegacyData: true, dryRun: true }).reportId).toBeDefined();
    expect(db.prepare('SELECT * FROM resources').all()).toEqual(before);
    expect(db.prepare('PRAGMA table_info(resources)').all()).toContainEqual(expect.objectContaining({ name: 'slug' }));
  });
});
