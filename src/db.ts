import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import * as vscode from 'vscode';
import {
  DEFAULT_TOPIC_TYPE,
  isTopicTypeId,
  TOPIC_TYPE_IDS,
  type TopicTypeId,
} from './topicTypes';

export interface Workstream {
  id: number;
  slug: string;
  title: string;
  status: string;
  opened_at: number;
  closed_at: number | null;
  closure: string | null;
  deleted_at: number | null;
}

export interface WorkstreamWithCount extends Workstream {
  session_count: number;
  last_activity_at?: number;
}

export interface Session {
  session_id: string;
  workstream_id: number;
  started_at: number;
  ended_at: number | null;
  summary: string | null;
  deleted_at: number | null;
}

export interface Entry {
  id: number;
  session_id: string;
  timestamp: number;
  body: string;
  deleted_at: number | null;
}

export interface SearchHit {
  id: number;
  session_id: string;
  timestamp: number;
  body: string;
  snippet: string;
  workstream_id: number;
  workstream_slug: string;
  workstream_title: string;
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

interface Migration {
  version: number;
  file: string;
}

const MIGRATIONS: Migration[] = [
  { version: 1, file: '001_initial.sql' },
  { version: 2, file: '002_soft_delete.sql' },
  { version: 3, file: '003_topics.sql' },
  { version: 4, file: '004_topic_status_open_closed.sql' },
  { version: 5, file: '005_safe_topic_rebuild_template.sql' },
  { version: 6, file: '006_topic_parents.sql' },
  { version: 7, file: '007_topic_type.sql' },
];

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

function runMigrations(instance: DatabaseSyncT, extensionPath: string): void {
  instance.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    INTEGER PRIMARY KEY,
       applied_at INTEGER NOT NULL
     )`,
  );

  // Bootstrap legacy DBs: if `workstreams` was created by the pre-tracking
  // codepath (v0.1.x), mark version 1 as already applied so we don't try to
  // re-run it.
  const hasWorkstreams = instance
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='workstreams'`,
    )
    .get();
  const v1Row = instance
    .prepare(`SELECT 1 AS x FROM schema_migrations WHERE version = 1`)
    .get();
  if (hasWorkstreams && !v1Row) {
    instance
      .prepare(
        `INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)`,
      )
      .run(nowEpoch());
  }

  for (const m of MIGRATIONS) {
    const applied = instance
      .prepare(`SELECT 1 AS x FROM schema_migrations WHERE version = ?`)
      .get(m.version);
    if (applied) {
      continue;
    }
    const sql = fs.readFileSync(
      path.join(extensionPath, 'schema', m.file),
      'utf8',
    );
    instance.exec('BEGIN');
    try {
      instance.exec(sql);
      instance
        .prepare(
          `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
        )
        .run(m.version, nowEpoch());
      instance.exec('COMMIT');
    } catch (err) {
      instance.exec('ROLLBACK');
      throw err;
    }
  }
}

/**
 * Open (or create) the journal DB and apply any pending schema migrations.
 * Returns null if there is no hub workspace.
 */
export function openDb(extensionPath: string): DatabaseSyncT | null {
  if (db) {
    return db;
  }
  const target = resolveDbPath();
  if (!target) {
    return null;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const { DatabaseSync } = loadSqlite();
  const instance = new DatabaseSync(target);
  // node:sqlite has no `.pragma()` helper — use exec().
  instance.exec('PRAGMA journal_mode = WAL');
  instance.exec('PRAGMA foreign_keys = ON');

  runMigrations(instance, extensionPath);

  db = instance;
  dbPath = target;
  return db;
}

export function getDbPath(): string | null {
  return dbPath;
}

export function isDbOpen(): boolean {
  return db !== null;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    dbPath = null;
  }
}

function requireDb(): DatabaseSyncT {
  if (!db) {
    throw new Error(
      'journal DB is not open (no hub workspace, or activation failed)',
    );
  }
  return db;
}

function withTransaction<T>(fn: () => T): T {
  const handle = requireDb();
  handle.exec('BEGIN');
  try {
    const out = fn();
    handle.exec('COMMIT');
    return out;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Workstreams
// ---------------------------------------------------------------------------

export interface ListWorkstreamsOptions {
  status?: 'open' | 'closed' | 'all';
  includeDeleted?: boolean;
  /**
   * Sort order. Defaults to `opened-asc` (oldest first), matching the original
   * tree behavior. `closed-desc` is used by the Archive tab to show
   * most-recently-closed first; rows with a null `closed_at` sink to the end.
   * `last-activity-desc` sorts by the most recent (non-deleted) entry
   * timestamp across the workstream's sessions, falling back to `opened_at`
   * when no entries exist.
   */
  orderBy?: 'opened-asc' | 'closed-desc' | 'last-activity-desc';
}

export function listWorkstreams(
  opts: ListWorkstreamsOptions = {},
): WorkstreamWithCount[] {
  if (!db) {
    return [];
  }
  const status = opts.status ?? 'all';
  const includeDeleted = opts.includeDeleted ?? false;
  const orderBy = opts.orderBy ?? 'opened-asc';

  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (!includeDeleted) {
    clauses.push('w.deleted_at IS NULL');
  }
  if (status !== 'all') {
    clauses.push('w.status = ?');
    params.push(status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  let orderSql: string;
  if (orderBy === 'closed-desc') {
    orderSql = 'ORDER BY w.closed_at IS NULL, w.closed_at DESC, w.id DESC';
  } else if (orderBy === 'last-activity-desc') {
    orderSql = 'ORDER BY last_activity_at DESC, w.id DESC';
  } else {
    orderSql = 'ORDER BY w.opened_at ASC, w.id ASC';
  }

  const lastActivitySelect =
    orderBy === 'last-activity-desc'
      ? `,
           COALESCE(
             (SELECT MAX(e.timestamp)
                FROM entries e
                JOIN sessions s ON s.session_id = e.session_id
               WHERE s.workstream_id = w.id
                 AND s.deleted_at IS NULL
                 AND e.deleted_at IS NULL),
             w.opened_at
           ) AS last_activity_at`
      : '';

  const sql = `
    SELECT w.id, w.slug, w.title, w.status, w.opened_at, w.closed_at,
           w.closure, w.deleted_at,
           (SELECT COUNT(*) FROM sessions s
              WHERE s.workstream_id = w.id AND s.deleted_at IS NULL)
             AS session_count${lastActivitySelect}
      FROM workstreams w
      ${where}
      ${orderSql}
  `;
  return db.prepare(sql).all(...params) as unknown as WorkstreamWithCount[];
}

export function getWorkstreamBySlug(
  slug: string,
  includeDeleted = false,
): Workstream | null {
  if (!db) {
    return null;
  }
  const sql = `
    SELECT id, slug, title, status, opened_at, closed_at, closure, deleted_at
      FROM workstreams
      WHERE slug = ?
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
  `;
  const row = db.prepare(sql).get(slug) as unknown as Workstream | undefined;
  return row ?? null;
}

export function getWorkstreamById(
  id: number,
  includeDeleted = false,
): Workstream | null {
  if (!db) {
    return null;
  }
  const sql = `
    SELECT id, slug, title, status, opened_at, closed_at, closure, deleted_at
      FROM workstreams
      WHERE id = ?
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
  `;
  const row = db.prepare(sql).get(id) as unknown as Workstream | undefined;
  return row ?? null;
}

export interface CreateWorkstreamInput {
  slug: string;
  title: string;
  status?: 'open' | 'closed';
}

export function createWorkstream(input: CreateWorkstreamInput): Workstream {
  const handle = requireDb();
  if (!input.slug || !input.title) {
    throw new Error('slug and title are required');
  }
  // Check across deleted too — UNIQUE(slug) is enforced regardless.
  const existing = getWorkstreamBySlug(input.slug, true);
  if (existing) {
    const tag = existing.deleted_at ? ' (soft-deleted)' : '';
    throw new Error(`workstream slug already exists${tag}: ${input.slug}`);
  }
  const status = input.status ?? 'open';
  const opened = nowEpoch();
  const closed = status === 'closed' ? opened : null;
  handle
    .prepare(
      `INSERT INTO workstreams (slug, title, status, opened_at, closed_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.slug, input.title, status, opened, closed);
  const row = getWorkstreamBySlug(input.slug);
  if (!row) {
    throw new Error('createWorkstream: insert succeeded but row not found');
  }
  return row;
}

export interface UpdateWorkstreamInput {
  title?: string;
  status?: 'open' | 'closed';
  closure?: string;
}

export function updateWorkstream(
  slug: string,
  patch: UpdateWorkstreamInput,
): Workstream {
  const handle = requireDb();
  const current = getWorkstreamBySlug(slug);
  if (!current) {
    throw new Error(`workstream not found: ${slug}`);
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
    if (patch.status === 'closed' && current.closed_at === null) {
      sets.push('closed_at = ?');
      params.push(nowEpoch());
    }
  }
  if (patch.closure !== undefined) {
    sets.push('closure = ?');
    params.push(patch.closure);
  }
  if (!sets.length) {
    return current;
  }
  params.push(slug);
  handle
    .prepare(`UPDATE workstreams SET ${sets.join(', ')} WHERE slug = ?`)
    .run(...params);
  const updated = getWorkstreamBySlug(slug);
  if (!updated) {
    throw new Error('updateWorkstream: row vanished after update');
  }
  return updated;
}

/**
 * Flip a closed workstream back to `open` and clear `closed_at`. Closure note
 * is preserved (it's still historically accurate). No-op (returns the row
 * unchanged) if the workstream is already open.
 */
export function reopenWorkstream(slug: string): Workstream {
  const handle = requireDb();
  const current = getWorkstreamBySlug(slug);
  if (!current) {
    throw new Error(`workstream not found: ${slug}`);
  }
  if (current.status === 'open' && current.closed_at === null) {
    return current;
  }
  handle
    .prepare(
      `UPDATE workstreams
          SET status = 'open', closed_at = NULL
        WHERE slug = ?`,
    )
    .run(slug);
  const updated = getWorkstreamBySlug(slug);
  if (!updated) {
    throw new Error('reopenWorkstream: row vanished after update');
  }
  return updated;
}

export interface SoftDeleteResult {
  workstreams: number;
  sessions: number;
  entries: number;
}

export function softDeleteWorkstream(slug: string): SoftDeleteResult {
  const handle = requireDb();
  const ws = getWorkstreamBySlug(slug);
  if (!ws) {
    throw new Error(`workstream not found: ${slug}`);
  }
  const ts = nowEpoch();

  return withTransaction(() => {
    // Collect entries we're about to soft-delete so we can drop them from FTS.
    const affectedEntries = handle
      .prepare(
        `SELECT e.id, e.body
           FROM entries e
           JOIN sessions s ON e.session_id = s.session_id
           WHERE s.workstream_id = ?
             AND e.deleted_at IS NULL`,
      )
      .all(ws.id) as unknown as { id: number; body: string }[];

    const ftsDel = handle.prepare(
      `INSERT INTO entries_fts(entries_fts, rowid, body) VALUES('delete', ?, ?)`,
    );
    for (const row of affectedEntries) {
      ftsDel.run(row.id, row.body);
    }

    const entryRes = handle
      .prepare(
        `UPDATE entries
            SET deleted_at = ?
          WHERE deleted_at IS NULL
            AND session_id IN (SELECT session_id FROM sessions
                                 WHERE workstream_id = ?)`,
      )
      .run(ts, ws.id);
    const sessionRes = handle
      .prepare(
        `UPDATE sessions SET deleted_at = ?
          WHERE workstream_id = ? AND deleted_at IS NULL`,
      )
      .run(ts, ws.id);
    const wsRes = handle
      .prepare(
        `UPDATE workstreams SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL`,
      )
      .run(ts, ws.id);

    return {
      workstreams: Number(wsRes.changes),
      sessions: Number(sessionRes.changes),
      entries: Number(entryRes.changes),
    };
  });
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export function listSessionsForWorkstream(
  workstreamId: number,
  includeDeleted = false,
): Session[] {
  if (!db) {
    return [];
  }
  const sql = `
    SELECT session_id, workstream_id, started_at, ended_at, summary, deleted_at
      FROM sessions
      WHERE workstream_id = ?
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
      ORDER BY started_at ASC
  `;
  return db.prepare(sql).all(workstreamId) as unknown as Session[];
}

export function getSession(
  sessionId: string,
  includeDeleted = false,
): Session | null {
  if (!db) {
    return null;
  }
  const sql = `
    SELECT session_id, workstream_id, started_at, ended_at, summary, deleted_at
      FROM sessions
      WHERE session_id = ?
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
  `;
  const row = db.prepare(sql).get(sessionId) as unknown as Session | undefined;
  return row ?? null;
}

export interface StartSessionInput {
  workstream_slug: string;
  summary?: string;
  session_id?: string;
}

export function startSession(input: StartSessionInput): Session {
  const handle = requireDb();
  const ws = getWorkstreamBySlug(input.workstream_slug);
  if (!ws) {
    throw new Error(`workstream not found: ${input.workstream_slug}`);
  }
  const sessionId = input.session_id ?? randomUUID();
  const existing = getSession(sessionId, true);
  if (existing) {
    throw new Error(`session_id already exists: ${sessionId}`);
  }
  handle
    .prepare(
      `INSERT INTO sessions (session_id, workstream_id, started_at, summary)
       VALUES (?, ?, ?, ?)`,
    )
    .run(sessionId, ws.id, nowEpoch(), input.summary ?? null);
  const row = getSession(sessionId);
  if (!row) {
    throw new Error('startSession: insert succeeded but row not found');
  }
  return row;
}

export function endSession(sessionId: string, summary?: string): Session {
  const handle = requireDb();
  const current = getSession(sessionId);
  if (!current) {
    throw new Error(`session not found: ${sessionId}`);
  }
  if (summary !== undefined) {
    handle
      .prepare(
        `UPDATE sessions SET ended_at = ?, summary = ? WHERE session_id = ?`,
      )
      .run(nowEpoch(), summary, sessionId);
  } else {
    handle
      .prepare(`UPDATE sessions SET ended_at = ? WHERE session_id = ?`)
      .run(nowEpoch(), sessionId);
  }
  const updated = getSession(sessionId);
  if (!updated) {
    throw new Error('endSession: row vanished after update');
  }
  return updated;
}

export function softDeleteSession(sessionId: string): SoftDeleteResult {
  const handle = requireDb();
  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`session not found: ${sessionId}`);
  }
  const ts = nowEpoch();

  return withTransaction(() => {
    const affectedEntries = handle
      .prepare(
        `SELECT id, body FROM entries
          WHERE session_id = ? AND deleted_at IS NULL`,
      )
      .all(sessionId) as unknown as { id: number; body: string }[];

    const ftsDel = handle.prepare(
      `INSERT INTO entries_fts(entries_fts, rowid, body) VALUES('delete', ?, ?)`,
    );
    for (const row of affectedEntries) {
      ftsDel.run(row.id, row.body);
    }

    const entryRes = handle
      .prepare(
        `UPDATE entries SET deleted_at = ?
          WHERE session_id = ? AND deleted_at IS NULL`,
      )
      .run(ts, sessionId);
    const sessionRes = handle
      .prepare(
        `UPDATE sessions SET deleted_at = ?
          WHERE session_id = ? AND deleted_at IS NULL`,
      )
      .run(ts, sessionId);

    return {
      workstreams: 0,
      sessions: Number(sessionRes.changes),
      entries: Number(entryRes.changes),
    };
  });
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

export function listEntriesForSession(
  sessionId: string,
  includeDeleted = false,
): Entry[] {
  if (!db) {
    return [];
  }
  const sql = `
    SELECT id, session_id, timestamp, body, deleted_at
      FROM entries
      WHERE session_id = ?
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
      ORDER BY timestamp ASC, id ASC
  `;
  return db.prepare(sql).all(sessionId) as unknown as Entry[];
}

export interface AppendEntryInput {
  session_id: string;
  body: string;
  timestamp?: number;
}

export function appendEntry(input: AppendEntryInput): Entry {
  const handle = requireDb();
  if (!input.body || !input.body.trim()) {
    throw new Error('body is required');
  }
  const session = getSession(input.session_id);
  if (!session) {
    throw new Error(`session not found: ${input.session_id}`);
  }
  const ts = input.timestamp ?? nowEpoch();
  const result = handle
    .prepare(
      `INSERT INTO entries (session_id, timestamp, body)
       VALUES (?, ?, ?)`,
    )
    .run(input.session_id, ts, input.body);
  const id = Number(result.lastInsertRowid);
  return {
    id,
    session_id: input.session_id,
    timestamp: ts,
    body: input.body,
    deleted_at: null,
  };
}

export interface SearchEntriesInput {
  query: string;
  workstream_slug?: string;
  limit?: number;
}

export function searchEntries(input: SearchEntriesInput): SearchHit[] {
  if (!db) {
    return [];
  }
  const limit = Math.max(1, Math.min(input.limit ?? 25, 200));
  const clauses: string[] = [
    'entries_fts MATCH ?',
    'e.deleted_at IS NULL',
    's.deleted_at IS NULL',
    'w.deleted_at IS NULL',
  ];
  const params: (string | number)[] = [input.query];
  if (input.workstream_slug) {
    clauses.push('w.slug = ?');
    params.push(input.workstream_slug);
  }
  params.push(limit);
  const sql = `
    SELECT e.id, e.session_id, e.timestamp, e.body,
           snippet(entries_fts, 0, '<<', '>>', '…', 16) AS snippet,
           w.id   AS workstream_id,
           w.slug AS workstream_slug,
           w.title AS workstream_title
      FROM entries_fts
      JOIN entries     e ON entries_fts.rowid = e.id
      JOIN sessions    s ON e.session_id = s.session_id
      JOIN workstreams w ON s.workstream_id = w.id
     WHERE ${clauses.join(' AND ')}
     ORDER BY rank
     LIMIT ?
  `;
  return db.prepare(sql).all(...params) as unknown as SearchHit[];
}

export function softDeleteEntry(entryId: number): SoftDeleteResult {
  const handle = requireDb();
  const row = handle
    .prepare(
      `SELECT id, body FROM entries WHERE id = ? AND deleted_at IS NULL`,
    )
    .get(entryId) as unknown as { id: number; body: string } | undefined;
  if (!row) {
    throw new Error(`entry not found (or already deleted): ${entryId}`);
  }

  return withTransaction(() => {
    handle
      .prepare(
        `INSERT INTO entries_fts(entries_fts, rowid, body) VALUES('delete', ?, ?)`,
      )
      .run(row.id, row.body);
    const res = handle
      .prepare(`UPDATE entries SET deleted_at = ? WHERE id = ?`)
      .run(nowEpoch(), entryId);
    return {
      workstreams: 0,
      sessions: 0,
      entries: Number(res.changes),
    };
  });
}

// ---------------------------------------------------------------------------
// Topics (migration 003)
// ---------------------------------------------------------------------------

export type TopicStatus = 'open' | 'closed';

export interface Topic {
  slug: string;
  title: string;
  status: TopicStatus;
  topic_type: TopicTypeId;
  body: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export { TOPIC_TYPE_IDS, DEFAULT_TOPIC_TYPE, isTopicTypeId, type TopicTypeId };

export interface TopicWithCounts extends Topic {
  workstream_count: number;
  entry_count: number;
}

export interface TopicWorkstreamLink {
  workstream_id: number;
  workstream_slug: string;
  workstream_title: string;
  linked_at: number;
}

export interface TopicEntryLink {
  entry_id: number;
  session_id: string;
  timestamp: number;
  snippet: string;
  workstream_id: number;
  workstream_slug: string;
  workstream_title: string;
  linked_at: number;
}

export interface ListTopicsOptions {
  status?: TopicStatus | 'all';
  includeDeleted?: boolean;
  workstreamSlug?: string;
  topicType?: TopicTypeId;
}

function snippetBody(body: string, max = 200): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return collapsed.slice(0, max - 1).trimEnd() + '…';
}

export function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

export function listTopics(opts: ListTopicsOptions = {}): TopicWithCounts[] {
  if (!db) {
    return [];
  }
  const includeDeleted = opts.includeDeleted ?? false;
  const status = opts.status ?? 'all';
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (!includeDeleted) {
    clauses.push('t.deleted_at IS NULL');
  }
  if (status !== 'all') {
    clauses.push('t.status = ?');
    params.push(status);
  }
  if (opts.topicType !== undefined) {
    if (!isTopicTypeId(opts.topicType)) {
      throw new Error(
        `invalid topic_type: ${opts.topicType} (must be one of ${TOPIC_TYPE_IDS.join(', ')})`,
      );
    }
    clauses.push('t.topic_type = ?');
    params.push(opts.topicType);
  }
  let join = '';
  if (opts.workstreamSlug) {
    join = `JOIN workstream_topics wt ON wt.topic_slug = t.slug
            JOIN workstreams w ON w.id = wt.workstream_id`;
    clauses.push('wt.deleted_at IS NULL');
    clauses.push('w.slug = ?');
    if (!includeDeleted) {
      clauses.push('w.deleted_at IS NULL');
    }
    params.push(opts.workstreamSlug);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const sql = `
    SELECT t.slug, t.title, t.status, t.topic_type, t.body,
           t.created_at, t.updated_at, t.deleted_at,
           (SELECT COUNT(*) FROM workstream_topics wt2
              JOIN workstreams w2 ON w2.id = wt2.workstream_id
              WHERE wt2.topic_slug = t.slug
                AND wt2.deleted_at IS NULL
                AND w2.deleted_at IS NULL)
             AS workstream_count,
           (SELECT COUNT(*) FROM entry_topics et2
              JOIN entries e2 ON e2.id = et2.entry_id
              WHERE et2.topic_slug = t.slug
                AND et2.deleted_at IS NULL
                AND e2.deleted_at IS NULL)
             AS entry_count
      FROM topics t
      ${join}
      ${where}
      ORDER BY t.created_at ASC, t.slug ASC
  `;
  return db.prepare(sql).all(...params) as unknown as TopicWithCounts[];
}

export function getTopic(slug: string, includeDeleted = false): Topic | null {
  if (!db) {
    return null;
  }
  const sql = `
    SELECT slug, title, status, topic_type, body, created_at, updated_at, deleted_at
      FROM topics
      WHERE slug = ?
        ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
  `;
  const row = db.prepare(sql).get(slug) as unknown as Topic | undefined;
  return row ?? null;
}

export interface CreateTopicInput {
  slug: string;
  title?: string;
  body?: string;
  status?: TopicStatus;
  topic_type?: TopicTypeId;
}

export function createTopic(input: CreateTopicInput): Topic {
  const handle = requireDb();
  if (!input.slug || !input.slug.trim()) {
    throw new Error('slug is required');
  }
  const existing = getTopic(input.slug, true);
  if (existing) {
    const tag = existing.deleted_at ? ' (soft-deleted)' : '';
    throw new Error(`topic slug already exists${tag}: ${input.slug}`);
  }
  let topicType: TopicTypeId = DEFAULT_TOPIC_TYPE;
  if (input.topic_type !== undefined) {
    if (!isTopicTypeId(input.topic_type)) {
      throw new Error(
        `invalid topic_type: ${input.topic_type} (must be one of ${TOPIC_TYPE_IDS.join(', ')})`,
      );
    }
    topicType = input.topic_type;
  }
  const now = nowEpoch();
  const title = input.title?.trim() || humanizeSlug(input.slug);
  const status = input.status ?? 'open';
  handle
    .prepare(
      `INSERT INTO topics (slug, title, status, topic_type, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.slug, title, status, topicType, input.body ?? '', now, now);
  const row = getTopic(input.slug);
  if (!row) {
    throw new Error('createTopic: insert succeeded but row not found');
  }
  return row;
}

export interface UpdateTopicInput {
  title?: string;
  body?: string;
  status?: TopicStatus;
  topic_type?: TopicTypeId;
}

export function updateTopic(slug: string, patch: UpdateTopicInput): Topic {
  const handle = requireDb();
  const current = getTopic(slug);
  if (!current) {
    throw new Error(`topic not found: ${slug}`);
  }
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.title !== undefined) {
    sets.push('title = ?');
    params.push(patch.title);
  }
  if (patch.body !== undefined) {
    sets.push('body = ?');
    params.push(patch.body);
  }
  if (patch.status !== undefined) {
    sets.push('status = ?');
    params.push(patch.status);
  }
  if (patch.topic_type !== undefined) {
    if (!isTopicTypeId(patch.topic_type)) {
      throw new Error(
        `invalid topic_type: ${patch.topic_type} (must be one of ${TOPIC_TYPE_IDS.join(', ')})`,
      );
    }
    sets.push('topic_type = ?');
    params.push(patch.topic_type);
  }
  if (!sets.length) {
    return current;
  }
  sets.push('updated_at = ?');
  params.push(nowEpoch());
  params.push(slug);
  handle
    .prepare(`UPDATE topics SET ${sets.join(', ')} WHERE slug = ?`)
    .run(...params);
  const updated = getTopic(slug);
  if (!updated) {
    throw new Error('updateTopic: row vanished after update');
  }
  return updated;
}

export interface SoftDeleteTopicResult {
  topics: number;
  workstream_links: number;
  entry_links: number;
}

export function softDeleteTopic(slug: string): SoftDeleteTopicResult {
  const handle = requireDb();
  const topic = getTopic(slug);
  if (!topic) {
    throw new Error(`topic not found: ${slug}`);
  }
  const ts = nowEpoch();
  return withTransaction(() => {
    const t = handle
      .prepare(`UPDATE topics SET deleted_at = ? WHERE slug = ?`)
      .run(ts, slug);
    const w = handle
      .prepare(
        `UPDATE workstream_topics SET deleted_at = ?
           WHERE topic_slug = ? AND deleted_at IS NULL`,
      )
      .run(ts, slug);
    const e = handle
      .prepare(
        `UPDATE entry_topics SET deleted_at = ?
           WHERE topic_slug = ? AND deleted_at IS NULL`,
      )
      .run(ts, slug);
    return {
      topics: Number(t.changes),
      workstream_links: Number(w.changes),
      entry_links: Number(e.changes),
    };
  });
}

// ---- linking ---------------------------------------------------------------

export interface LinkWorkstreamTopicInput {
  workstream_slug: string;
  topic_slug: string;
}

export interface LinkWorkstreamTopicResult {
  workstream_slug: string;
  topic_slug: string;
  topic_created: boolean;
  link_created: boolean;
  link_restored: boolean;
  linked_at: number;
}

/**
 * Idempotently link a topic to a workstream. Auto-creates a stub topic if
 * the slug is unknown. If a soft-deleted link row exists, restore it (clear
 * `deleted_at` and refresh `created_at`). Used as a low-level helper by
 * `linkTopicToEntry` too.
 */
function ensureWorkstreamTopicLink(
  handle: DatabaseSyncT,
  workstreamId: number,
  workstreamSlug: string,
  topicSlug: string,
  now: number,
): { link_created: boolean; link_restored: boolean; linked_at: number } {
  const existing = handle
    .prepare(
      `SELECT created_at, deleted_at FROM workstream_topics
        WHERE workstream_id = ? AND topic_slug = ?`,
    )
    .get(workstreamId, topicSlug) as unknown as
    | { created_at: number; deleted_at: number | null }
    | undefined;
  if (existing && existing.deleted_at === null) {
    return {
      link_created: false,
      link_restored: false,
      linked_at: existing.created_at,
    };
  }
  if (existing && existing.deleted_at !== null) {
    handle
      .prepare(
        `UPDATE workstream_topics
            SET deleted_at = NULL, created_at = ?
          WHERE workstream_id = ? AND topic_slug = ?`,
      )
      .run(now, workstreamId, topicSlug);
    return { link_created: false, link_restored: true, linked_at: now };
  }
  handle
    .prepare(
      `INSERT INTO workstream_topics (workstream_id, topic_slug, created_at)
       VALUES (?, ?, ?)`,
    )
    .run(workstreamId, topicSlug, now);
  void workstreamSlug; // (logged by callers if useful)
  return { link_created: true, link_restored: false, linked_at: now };
}

function ensureTopicStub(
  handle: DatabaseSyncT,
  slug: string,
  now: number,
): { created: boolean } {
  const existing = handle
    .prepare(`SELECT deleted_at FROM topics WHERE slug = ?`)
    .get(slug) as unknown as { deleted_at: number | null } | undefined;
  if (existing) {
    if (existing.deleted_at !== null) {
      // Auto-undelete the topic so the link makes sense.
      handle
        .prepare(
          `UPDATE topics SET deleted_at = NULL, updated_at = ? WHERE slug = ?`,
        )
        .run(now, slug);
    }
    return { created: false };
  }
  handle
    .prepare(
      `INSERT INTO topics (slug, title, status, body, created_at, updated_at)
       VALUES (?, ?, 'open', '', ?, ?)`,
    )
    .run(slug, humanizeSlug(slug), now, now);
  return { created: true };
}

export function linkWorkstreamTopic(
  input: LinkWorkstreamTopicInput,
): LinkWorkstreamTopicResult {
  const handle = requireDb();
  const ws = getWorkstreamBySlug(input.workstream_slug);
  if (!ws) {
    throw new Error(
      `workstream not found (or soft-deleted): ${input.workstream_slug}`,
    );
  }
  return withTransaction(() => {
    const now = nowEpoch();
    const stub = ensureTopicStub(handle, input.topic_slug, now);
    const link = ensureWorkstreamTopicLink(
      handle,
      ws.id,
      ws.slug,
      input.topic_slug,
      now,
    );
    return {
      workstream_slug: ws.slug,
      topic_slug: input.topic_slug,
      topic_created: stub.created,
      link_created: link.link_created,
      link_restored: link.link_restored,
      linked_at: link.linked_at,
    };
  });
}

export interface UnlinkWorkstreamTopicResult {
  workstream_slug: string;
  topic_slug: string;
  removed: number;
}

export function unlinkWorkstreamTopic(
  input: LinkWorkstreamTopicInput,
): UnlinkWorkstreamTopicResult {
  const handle = requireDb();
  const ws = getWorkstreamBySlug(input.workstream_slug, true);
  if (!ws) {
    throw new Error(`workstream not found: ${input.workstream_slug}`);
  }
  const res = handle
    .prepare(
      `UPDATE workstream_topics SET deleted_at = ?
         WHERE workstream_id = ? AND topic_slug = ? AND deleted_at IS NULL`,
    )
    .run(nowEpoch(), ws.id, input.topic_slug);
  return {
    workstream_slug: ws.slug,
    topic_slug: input.topic_slug,
    removed: Number(res.changes),
  };
}

export interface LinkEntryTopicInput {
  entry_id: number;
  topic_slug: string;
}

export interface LinkEntryTopicResult {
  entry_id: number;
  topic_slug: string;
  workstream_slug: string;
  topic_created: boolean;
  entry_link_created: boolean;
  entry_link_restored: boolean;
  workstream_link_created: boolean;
  workstream_link_restored: boolean;
  linked_at: number;
}

export function linkEntryTopic(input: LinkEntryTopicInput): LinkEntryTopicResult {
  const handle = requireDb();
  // Look up entry + its workstream (rejecting soft-deleted hops).
  const row = handle
    .prepare(
      `SELECT e.id AS entry_id, s.session_id, w.id AS workstream_id, w.slug AS workstream_slug
         FROM entries e
         JOIN sessions s ON s.session_id = e.session_id
         JOIN workstreams w ON w.id = s.workstream_id
        WHERE e.id = ?
          AND e.deleted_at IS NULL
          AND s.deleted_at IS NULL
          AND w.deleted_at IS NULL`,
    )
    .get(input.entry_id) as unknown as
    | {
        entry_id: number;
        session_id: string;
        workstream_id: number;
        workstream_slug: string;
      }
    | undefined;
  if (!row) {
    throw new Error(
      `entry not found (or its session/workstream is soft-deleted): ${input.entry_id}`,
    );
  }

  return withTransaction(() => {
    const now = nowEpoch();
    const stub = ensureTopicStub(handle, input.topic_slug, now);

    // Entry link: insert if missing; restore if soft-deleted.
    const existingEntryLink = handle
      .prepare(
        `SELECT created_at, deleted_at FROM entry_topics
          WHERE entry_id = ? AND topic_slug = ?`,
      )
      .get(input.entry_id, input.topic_slug) as unknown as
      | { created_at: number; deleted_at: number | null }
      | undefined;
    let entry_link_created = false;
    let entry_link_restored = false;
    let linked_at = now;
    if (!existingEntryLink) {
      handle
        .prepare(
          `INSERT INTO entry_topics (entry_id, topic_slug, created_at)
           VALUES (?, ?, ?)`,
        )
        .run(input.entry_id, input.topic_slug, now);
      entry_link_created = true;
    } else if (existingEntryLink.deleted_at !== null) {
      handle
        .prepare(
          `UPDATE entry_topics SET deleted_at = NULL, created_at = ?
            WHERE entry_id = ? AND topic_slug = ?`,
        )
        .run(now, input.entry_id, input.topic_slug);
      entry_link_restored = true;
    } else {
      linked_at = existingEntryLink.created_at;
    }

    // Auto-link the topic to the entry's workstream (idempotent + restore).
    const wsLink = ensureWorkstreamTopicLink(
      handle,
      row.workstream_id,
      row.workstream_slug,
      input.topic_slug,
      now,
    );

    return {
      entry_id: input.entry_id,
      topic_slug: input.topic_slug,
      workstream_slug: row.workstream_slug,
      topic_created: stub.created,
      entry_link_created,
      entry_link_restored,
      workstream_link_created: wsLink.link_created,
      workstream_link_restored: wsLink.link_restored,
      linked_at,
    };
  });
}

export interface UnlinkEntryTopicResult {
  entry_id: number;
  topic_slug: string;
  removed: number;
}

export function unlinkEntryTopic(
  input: LinkEntryTopicInput,
): UnlinkEntryTopicResult {
  const handle = requireDb();
  const res = handle
    .prepare(
      `UPDATE entry_topics SET deleted_at = ?
         WHERE entry_id = ? AND topic_slug = ? AND deleted_at IS NULL`,
    )
    .run(nowEpoch(), input.entry_id, input.topic_slug);
  return {
    entry_id: input.entry_id,
    topic_slug: input.topic_slug,
    removed: Number(res.changes),
  };
}

// ---- topic query helpers (for tools + virtual docs) -----------------------

export function listWorkstreamsForTopic(
  topicSlug: string,
): TopicWorkstreamLink[] {
  if (!db) {
    return [];
  }
  const sql = `
    SELECT w.id AS workstream_id, w.slug AS workstream_slug,
           w.title AS workstream_title, wt.created_at AS linked_at
      FROM workstream_topics wt
      JOIN workstreams w ON w.id = wt.workstream_id
      WHERE wt.topic_slug = ?
        AND wt.deleted_at IS NULL
        AND w.deleted_at IS NULL
      ORDER BY wt.created_at DESC, w.slug ASC
  `;
  return db.prepare(sql).all(topicSlug) as unknown as TopicWorkstreamLink[];
}

export function listEntriesForTopic(
  topicSlug: string,
  limit = 25,
): TopicEntryLink[] {
  if (!db) {
    return [];
  }
  const sql = `
    SELECT e.id AS entry_id, e.session_id, e.timestamp, e.body,
           w.id AS workstream_id, w.slug AS workstream_slug,
           w.title AS workstream_title, et.created_at AS linked_at
      FROM entry_topics et
      JOIN entries e   ON e.id = et.entry_id
      JOIN sessions s  ON s.session_id = e.session_id
      JOIN workstreams w ON w.id = s.workstream_id
      WHERE et.topic_slug = ?
        AND et.deleted_at IS NULL
        AND e.deleted_at IS NULL
        AND s.deleted_at IS NULL
        AND w.deleted_at IS NULL
      ORDER BY e.timestamp DESC, e.id DESC
      LIMIT ?
  `;
  const rows = db.prepare(sql).all(topicSlug, limit) as unknown as ({
    entry_id: number;
    session_id: string;
    timestamp: number;
    body: string;
    workstream_id: number;
    workstream_slug: string;
    workstream_title: string;
    linked_at: number;
  })[];
  return rows.map((r) => ({
    entry_id: r.entry_id,
    session_id: r.session_id,
    timestamp: r.timestamp,
    snippet: snippetBody(r.body),
    workstream_id: r.workstream_id,
    workstream_slug: r.workstream_slug,
    workstream_title: r.workstream_title,
    linked_at: r.linked_at,
  }));
}

export interface WorkstreamTopicRow extends TopicWithCounts {
  linked_at: number;
  entry_count_in_workstream: number;
}

export function listTopicsForWorkstream(
  workstreamId: number,
): WorkstreamTopicRow[] {
  if (!db) {
    return [];
  }
  const sql = `
    SELECT t.slug, t.title, t.status, t.topic_type, t.body,
           t.created_at, t.updated_at, t.deleted_at,
           wt.created_at AS linked_at,
           (SELECT COUNT(*) FROM workstream_topics wt2
              JOIN workstreams w2 ON w2.id = wt2.workstream_id
              WHERE wt2.topic_slug = t.slug
                AND wt2.deleted_at IS NULL
                AND w2.deleted_at IS NULL)
             AS workstream_count,
           (SELECT COUNT(*) FROM entry_topics et2
              JOIN entries e2 ON e2.id = et2.entry_id
              WHERE et2.topic_slug = t.slug
                AND et2.deleted_at IS NULL
                AND e2.deleted_at IS NULL)
             AS entry_count,
           (SELECT COUNT(*) FROM entry_topics et3
              JOIN entries e3 ON e3.id = et3.entry_id
              JOIN sessions s3 ON s3.session_id = e3.session_id
              WHERE et3.topic_slug = t.slug
                AND et3.deleted_at IS NULL
                AND e3.deleted_at IS NULL
                AND s3.deleted_at IS NULL
                AND s3.workstream_id = ?)
             AS entry_count_in_workstream
      FROM workstream_topics wt
      JOIN topics t ON t.slug = wt.topic_slug
      WHERE wt.workstream_id = ?
        AND wt.deleted_at IS NULL
        AND t.deleted_at IS NULL
      ORDER BY wt.created_at DESC, t.slug ASC
  `;
  return db
    .prepare(sql)
    .all(workstreamId, workstreamId) as unknown as WorkstreamTopicRow[];
}

// ---------------------------------------------------------------------------
// Topic parents (migration 006 — DAG)
// ---------------------------------------------------------------------------

/**
 * Active parent topics of `slug` — only links and parent topics that are
 * not soft-deleted. Ordered by `created_at DESC, slug ASC` so the most
 * recently linked parent surfaces first.
 */
export function listTopicParents(slug: string): Topic[] {
  if (!db) {
    return [];
  }
  const sql = `
    SELECT t.slug, t.title, t.status, t.topic_type, t.body,
           t.created_at, t.updated_at, t.deleted_at
      FROM topic_parents tp
      JOIN topics t ON t.slug = tp.parent_slug
      WHERE tp.child_slug = ?
        AND tp.deleted_at IS NULL
        AND t.deleted_at IS NULL
      ORDER BY tp.created_at DESC, t.slug ASC
  `;
  return db.prepare(sql).all(slug) as unknown as Topic[];
}

/**
 * Active child topics of `slug` — only links and child topics that are
 * not soft-deleted. Ordered by `created_at ASC, slug ASC` so children
 * render in the order they were linked (stable, parent-first feel).
 */
export function listTopicChildren(slug: string): Topic[] {
  if (!db) {
    return [];
  }
  const sql = `
    SELECT t.slug, t.title, t.status, t.topic_type, t.body,
           t.created_at, t.updated_at, t.deleted_at
      FROM topic_parents tp
      JOIN topics t ON t.slug = tp.child_slug
      WHERE tp.parent_slug = ?
        AND tp.deleted_at IS NULL
        AND t.deleted_at IS NULL
      ORDER BY tp.created_at ASC, t.slug ASC
  `;
  return db.prepare(sql).all(slug) as unknown as Topic[];
}

export interface AddTopicParentResult {
  child_slug: string;
  parent_slug: string;
  created_at: number;
  link_restored: boolean;
}

/**
 * Link a child topic to a parent topic (DAG, M:N). Throws on:
 *   - self-link
 *   - either topic missing or soft-deleted
 *   - cycle (parent_slug is already a descendant of child_slug, i.e.
 *     child_slug appears in the ancestor closure walked upward from
 *     parent_slug)
 *
 * Idempotent: if an active link already exists, it's returned unchanged.
 * If a soft-deleted link row exists, it is restored.
 */
export function addTopicParent(
  childSlug: string,
  parentSlug: string,
): AddTopicParentResult {
  const handle = requireDb();
  if (childSlug === parentSlug) {
    throw new Error(`cannot link a topic to itself: ${childSlug}`);
  }
  const child = getTopic(childSlug);
  if (!child) {
    throw new Error(`child topic not found (or soft-deleted): ${childSlug}`);
  }
  const parent = getTopic(parentSlug);
  if (!parent) {
    throw new Error(`parent topic not found (or soft-deleted): ${parentSlug}`);
  }

  return withTransaction(() => {
    // Cycle check: walk the ancestor closure UP from parent_slug (seeded
    // with parent_slug itself). If child_slug appears anywhere in that
    // set, the new link would close a loop. The seed catches the self-link
    // case too, but we've already rejected it above for a clearer error.
    const cycleHit = handle
      .prepare(
        `WITH RECURSIVE ancestors(slug) AS (
            SELECT ? AS slug
           UNION
            SELECT tp.parent_slug
              FROM topic_parents tp
              JOIN ancestors a ON a.slug = tp.child_slug
              WHERE tp.deleted_at IS NULL
          )
          SELECT 1 AS x FROM ancestors WHERE slug = ? LIMIT 1`,
      )
      .get(parentSlug, childSlug);
    if (cycleHit) {
      throw new Error(
        `cycle: '${parentSlug}' is already a descendant of '${childSlug}'`,
      );
    }

    const now = nowEpoch();
    const existing = handle
      .prepare(
        `SELECT created_at, deleted_at FROM topic_parents
          WHERE child_slug = ? AND parent_slug = ?`,
      )
      .get(childSlug, parentSlug) as unknown as
      | { created_at: number; deleted_at: number | null }
      | undefined;

    if (existing && existing.deleted_at === null) {
      return {
        child_slug: childSlug,
        parent_slug: parentSlug,
        created_at: existing.created_at,
        link_restored: false,
      };
    }
    if (existing && existing.deleted_at !== null) {
      handle
        .prepare(
          `UPDATE topic_parents
              SET deleted_at = NULL, created_at = ?
            WHERE child_slug = ? AND parent_slug = ?`,
        )
        .run(now, childSlug, parentSlug);
      return {
        child_slug: childSlug,
        parent_slug: parentSlug,
        created_at: now,
        link_restored: true,
      };
    }
    handle
      .prepare(
        `INSERT INTO topic_parents (child_slug, parent_slug, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(childSlug, parentSlug, now);
    return {
      child_slug: childSlug,
      parent_slug: parentSlug,
      created_at: now,
      link_restored: false,
    };
  });
}

export interface RemoveTopicParentResult {
  child_slug: string;
  parent_slug: string;
  removed: number;
}

/**
 * Soft-delete a topic parent link. Idempotent — returns `removed: 0` if
 * the link doesn't exist or is already soft-deleted.
 */
export function removeTopicParent(
  childSlug: string,
  parentSlug: string,
): RemoveTopicParentResult {
  const handle = requireDb();
  const res = handle
    .prepare(
      `UPDATE topic_parents SET deleted_at = ?
         WHERE child_slug = ? AND parent_slug = ? AND deleted_at IS NULL`,
    )
    .run(nowEpoch(), childSlug, parentSlug);
  return {
    child_slug: childSlug,
    parent_slug: parentSlug,
    removed: Number(res.changes),
  };
}
