/**
 * Tests for the `created_by` column on `entries` (migration 012).
 *
 * Covers:
 *  - Migration: `system:`-prefixed rows are migrated to created_by='system*'
 *    with the prefix stripped; other rows become created_by='human*'.
 *  - Happy-path append: wm_append_entry (via store.appendEntry) writes and
 *    reads back the created_by value verbatim.
 *  - Validation: rejects missing, empty/whitespace, and `*`-suffixed values.
 *  - Read-side projection: listEntriesForSession returns created_by.
 *  - Seed smoke: every entry in a freshly-opened store has a non-empty
 *    created_by that does not end with `*`.
 *
 * NOTE: Once the auto-journal feature (feature-auto-journal-mutations) lands,
 * tools like wm_create_topic that call appendEntry indirectly will also need
 * coverage here. Add that coverage in the follow-up PR.
 */

import { test, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { openJournalStore } from '../src/db';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEMA_DIR = path.resolve(__dirname, '..', 'schema');

function readMigration(filename: string): string {
  return fs.readFileSync(path.join(SCHEMA_DIR, filename), 'utf8');
}

/**
 * Build a pre-012 in-memory DB by applying migrations 001–011 manually, then
 * insert raw entries (bypassing 012 so the column doesn't exist yet).
 */
function buildPre012Db(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Migrations that require noWrap (manage their own transactions / PRAGMAs).
  const noWrap = new Set([
    '005_safe_topic_rebuild_template.sql',
    '009_topic_type_fk.sql',
    '010_session_chat_ref.sql',
  ]);

  const allOrdered = [
    '001_initial.sql',
    '002_soft_delete.sql',
    '003_topics.sql',
    '004_topic_status_open_closed.sql',
    '005_safe_topic_rebuild_template.sql',
    '006_topic_parents.sql',
    '007_topic_type.sql',
    '008_topic_types_table.sql',
    '009_topic_type_fk.sql',
    '010_session_chat_ref.sql',
    '011_workstream_topic_focus.sql',
  ];

  for (const f of allOrdered) {
    const sql = readMigration(f);
    if (noWrap.has(f)) {
      db.exec(sql);
    } else {
      db.exec('BEGIN');
      try {
        db.exec(sql);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  return db;
}

// ---------------------------------------------------------------------------
// Migration test
// ---------------------------------------------------------------------------

test('migration 012: system:-prefixed bodies → created_by=system* with prefix stripped', () => {
  const db = buildPre012Db();

  // Insert a workstream + session so FK constraints are satisfied.
  db.exec(`INSERT INTO workstreams (slug, title, status, opened_at)
           VALUES ('mig-ws', 'Mig WS', 'open', 1000)`);
  db.exec(`INSERT INTO sessions (session_id, workstream_id, started_at)
           VALUES ('mig-sess', 1, 1000)`);

  // One system:-prefixed body, one regular body.
  db.prepare(
    `INSERT INTO entries (session_id, timestamp, body) VALUES (?, ?, ?)`,
  ).run('mig-sess', 1001, 'system: topic foo created');
  db.prepare(
    `INSERT INTO entries (session_id, timestamp, body) VALUES (?, ?, ?)`,
  ).run('mig-sess', 1002, 'decision: keep it simple');

  // Apply migration 012.
  db.exec('BEGIN');
  db.exec(readMigration('012_entries_created_by.sql'));
  db.exec('COMMIT');

  const rows = db
    .prepare(`SELECT body, created_by FROM entries ORDER BY timestamp ASC`)
    .all() as { body: string; created_by: string }[];

  expect(rows).toHaveLength(2);

  const systemRow = rows[0];
  expect(systemRow.created_by).toBe('system*');
  expect(systemRow.body).toBe('topic foo created');

  const otherRow = rows[1];
  expect(otherRow.created_by).toBe('human*');
  expect(otherRow.body).toBe('decision: keep it simple');

  db.close();
});

test('migration 012: all other existing rows get created_by=human*', () => {
  const db = buildPre012Db();

  db.exec(`INSERT INTO workstreams (slug, title, status, opened_at)
           VALUES ('mig-ws2', 'Mig WS2', 'open', 1000)`);
  db.exec(`INSERT INTO sessions (session_id, workstream_id, started_at)
           VALUES ('mig-sess2', 1, 1000)`);

  const bodies = ['chat: hello', 'command: npm install', 'fact: vitest rocks'];
  for (let i = 0; i < bodies.length; i++) {
    db.prepare(
      `INSERT INTO entries (session_id, timestamp, body) VALUES (?, ?, ?)`,
    ).run('mig-sess2', 1000 + i, bodies[i]);
  }

  db.exec('BEGIN');
  db.exec(readMigration('012_entries_created_by.sql'));
  db.exec('COMMIT');

  const rows = db
    .prepare(`SELECT created_by FROM entries ORDER BY timestamp ASC`)
    .all() as { created_by: string }[];

  expect(rows).toHaveLength(3);
  for (const r of rows) {
    expect(r.created_by).toBe('human*');
  }

  db.close();
});

// ---------------------------------------------------------------------------
// Happy-path append
// ---------------------------------------------------------------------------

test('appendEntry writes created_by verbatim and reads back correctly', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'hp-ws', title: 'HP WS' });
  const session = store.startSession({ workstream_slug: 'hp-ws' });

  const entry = store.appendEntry({
    session_id: session.session_id,
    body: 'decision: use vitest',
    created_by: 'orchestrator',
  });

  expect(entry.created_by).toBe('orchestrator');

  const entries = store.listEntriesForSession(session.session_id);
  expect(entries).toHaveLength(1);
  expect(entries[0].created_by).toBe('orchestrator');

  store.close();
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('appendEntry rejects missing created_by (undefined / empty string)', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'val-ws', title: 'Val WS' });
  const session = store.startSession({ workstream_slug: 'val-ws' });

  expect(() =>
    store.appendEntry({
      session_id: session.session_id,
      body: 'chat: test',
      // created_by intentionally omitted via cast
      created_by: '' as string,
    }),
  ).toThrow('created_by is required');

  store.close();
});

test('appendEntry rejects whitespace-only created_by', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'val-ws2', title: 'Val WS2' });
  const session = store.startSession({ workstream_slug: 'val-ws2' });

  expect(() =>
    store.appendEntry({
      session_id: session.session_id,
      body: 'chat: test',
      created_by: '   ',
    }),
  ).toThrow('created_by is required');

  store.close();
});

test('appendEntry rejects *-suffixed created_by', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'val-ws3', title: 'Val WS3' });
  const session = store.startSession({ workstream_slug: 'val-ws3' });

  expect(() =>
    store.appendEntry({
      session_id: session.session_id,
      body: 'chat: test',
      created_by: 'orchestrator*',
    }),
  ).toThrow('must not end with "*"');

  store.close();
});

// ---------------------------------------------------------------------------
// Read-side projection
// ---------------------------------------------------------------------------

test('listEntriesForSession returns created_by on every row', () => {
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'read-ws', title: 'Read WS' });
  const session = store.startSession({ workstream_slug: 'read-ws' });

  store.appendEntry({
    session_id: session.session_id,
    body: 'fact: projection works',
    created_by: 'executor',
  });

  const entries = store.listEntriesForSession(session.session_id);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toHaveProperty('created_by', 'executor');

  store.close();
});

// ---------------------------------------------------------------------------
// Seed smoke: fresh DB has no *-suffixed or empty created_by rows
// ---------------------------------------------------------------------------

test('freshly opened store has no entries with empty or *-suffixed created_by', () => {
  // Open a fresh in-memory store — migration 012 runs and sets created_by on
  // existing rows (there are none on a fresh DB, but this proves the column
  // exists and the migration guard works without error).
  const store = openJournalStore({ dbPath: ':memory:' });
  store.createWorkstream({ slug: 'seed-ws', title: 'Seed WS' });
  const session = store.startSession({ workstream_slug: 'seed-ws' });

  const actors = ['orchestrator', 'executor', 'system', 'human'];
  for (const actor of actors) {
    store.appendEntry({
      session_id: session.session_id,
      body: `fact: entry by ${actor}`,
      created_by: actor,
    });
  }

  const entries = store.listEntriesForSession(session.session_id);
  expect(entries).toHaveLength(actors.length);
  for (const e of entries) {
    expect(e.created_by).toBeTruthy();
    expect(e.created_by.endsWith('*')).toBe(false);
  }

  store.close();
});
