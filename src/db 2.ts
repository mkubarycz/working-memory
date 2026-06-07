import * as fs from 'fs';
import * as path from 'path';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import * as vscode from 'vscode';

export interface Workstream {
  id: number;
  slug: string;
  title: string;
  status: string;
  opened_at: number;
  closed_at: number | null;
  closure: string | null;
}

export interface Session {
  session_id: string;
  workstream_id: number;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
}

export interface Entry {
  id: number;
  session_id: string;
  timestamp: number;
  body: string;
}

let db: DatabaseSyncT | null = null;
let dbPath: string | null = null;

/**
 * Lazily require `node:sqlite` so any load-time error (e.g. missing
 * `--experimental-sqlite` flag on an old runtime) is caught by the
 * try/catch around `openDb()` in `extension.ts` instead of crashing the
 * whole extension at import time.
 */
function loadSqlite(): typeof import('node:sqlite') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:sqlite');
}

/**
 * Find the hub workspace folder — the one containing both `AGENTS.md` and
 * a `memory/` directory. Returns `null` if not found among the open folders.
 */
export function findHubWorkspace(): string | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const agents = path.join(root, 'AGENTS.md');
    const memory = path.join(root, 'memory');
    try {
      if (fs.statSync(agents).isFile() && fs.statSync(memory).isDirectory()) {
        return root;
      }
    } catch {
      // not this folder
    }
  }
  return null;
}

/**
 * Resolve the SQLite path: `<hub>/memory/journal.sqlite`. Returns null if no
 * hub workspace is open.
 */
export function resolveDbPath(): string | null {
  const hub = findHubWorkspace();
  if (!hub) {
    return null;
  }
  return path.join(hub, 'memory', 'journal.sqlite');
}

/**
 * Open (or create) the journal DB and run the initial migration if the
 * `workstreams` table is missing. Returns null if there is no hub workspace.
 */
export function openDb(extensionPath: string): DatabaseSyncT | null {
  if (db) {
    return db;
  }
  const target = resolveDbPath();
  if (!target) {
    return null;
  }
  // Ensure parent directory exists.
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const instance = new DatabaseSync(target);
  // node:sqlite has no `.pragma()` helper — use exec().
  instance.exec('PRAGMA journal_mode = WAL');
  instance.exec('PRAGMA foreign_keys = ON');

  const hasWorkstreams = instance
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='workstreams'`,
    )
    .get();

  if (!hasWorkstreams) {
    const schemaPath = path.join(extensionPath, 'schema', '001_initial.sql');
    const sql = fs.readFileSync(schemaPath, 'utf8');
    instance.exec(sql);
  }

  db = instance;
  dbPath = target;
  return db;
}

export function getDbPath(): string | null {
  return dbPath;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    dbPath = null;
  }
}

export function listWorkstreams(): Workstream[] {
  if (!db) {
    return [];
  }
  return db
    .prepare(
      `SELECT id, slug, title, status, opened_at, closed_at, closure
       FROM workstreams
       ORDER BY opened_at ASC, id ASC`,
    )
    .all() as unknown as Workstream[];
}

export function getWorkstreamBySlug(slug: string): Workstream | null {
  if (!db) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT id, slug, title, status, opened_at, closed_at, closure
       FROM workstreams WHERE slug = ?`,
    )
    .get(slug) as unknown as Workstream | undefined;
  return row ?? null;
}

export function listSessionsForWorkstream(workstreamId: number): Session[] {
  if (!db) {
    return [];
  }
  return db
    .prepare(
      `SELECT session_id, workstream_id, started_at, ended_at, summary
       FROM sessions WHERE workstream_id = ?
       ORDER BY started_at ASC`,
    )
    .all(workstreamId) as unknown as Session[];
}

export function listEntriesForSession(sessionId: string): Entry[] {
  if (!db) {
    return [];
  }
  return db
    .prepare(
      `SELECT id, session_id, timestamp, body
       FROM entries WHERE session_id = ?
       ORDER BY timestamp ASC`,
    )
    .all(sessionId) as unknown as Entry[];
}
