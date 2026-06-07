/**
 * Standalone DB seeder. Run after building:
 *
 *   npm run compile && npm run seed
 *
 * Idempotent: only inserts when `workstreams` is empty. Re-run after wiping
 * the DB to repopulate the example rows.
 *
 * Resolves the DB path relative to this file's location:
 *   <hub>/projects/working-memory/scripts/seed.ts
 *   <hub>/memory/journal.sqlite
 */
import * as fs from 'fs';
import * as path from 'path';
import { DatabaseSync } from 'node:sqlite';

const HUB = path.resolve(__dirname, '..', '..', '..', '..');
const DB_PATH = path.join(HUB, 'memory', 'journal.sqlite');
const SCHEMA_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'schema',
  '001_initial.sql',
);

interface Seed {
  slug: string;
  title: string;
}

const SEEDS: Seed[] = [
  { slug: 'memory-system', title: 'Memory System Design' },
  { slug: 'bootstrap-flow', title: 'Workspace Bootstrap' },
  { slug: 'working-memory-extension', title: 'Working Memory Extension' },
];

function main(): void {
  console.log(`[seed] hub workspace: ${HUB}`);
  console.log(`[seed] db path:       ${DB_PATH}`);

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const hasWorkstreams = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='workstreams'`,
    )
    .get();
  if (!hasWorkstreams) {
    console.log('[seed] applying initial schema');
    db.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  }

  const count = (
    db.prepare(`SELECT COUNT(*) as n FROM workstreams`).get() as { n: number }
  ).n;

  if (count > 0) {
    console.log(`[seed] workstreams already populated (${count} rows); skipping`);
    db.close();
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const insert = db.prepare(
    `INSERT INTO workstreams (slug, title, status, opened_at) VALUES (?, ?, 'open', ?)`,
  );

  // node:sqlite has no `.transaction()` helper — wrap manually.
  db.exec('BEGIN');
  try {
    for (const r of SEEDS) {
      insert.run(r.slug, r.title, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  console.log(`[seed] inserted ${SEEDS.length} workstreams`);
  db.close();
}

main();
