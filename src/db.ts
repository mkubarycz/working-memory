import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';

/**
 * Default value for `topics.topic_type` when a caller doesn't specify one.
 * Matches the column DEFAULT set in migration 007. Also the id of the
 * always-seeded built-in row in `topic_types`.
 */
export const DEFAULT_TOPIC_TYPE = 'topic';

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
  /**
   * Optional, free-form identifier of the chat/conversation that produced
   * this session. Populated by `wm_start_session` when the caller supplies
   * `chat_ref` (typically the path to the VS Code chat debug-logs folder).
   * NULL when not recorded — the session virtual doc renders that as
   * "(no chat link recorded)" rather than fabricating a link. Added in
   * migration 010.
   */
  chat_ref: string | null;
  deleted_at: number | null;
}

export interface Entry {
  id: number;
  session_id: string;
  timestamp: number;
  body: string;
  created_by: string;
  deleted_at: number | null;
}

export interface SearchHit {
  id: number;
  session_id: string;
  timestamp: number;
  body: string;
  created_by: string;
  snippet: string;
  workstream_id: number;
  workstream_slug: string;
  workstream_title: string;
}

export type TopicStatus = 'open' | 'closed';

export interface Topic {
  slug: string;
  title: string;
  status: TopicStatus;
  topic_type: string;
  body: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface TopicType {
  id: string;
  label: string;
  icon: string;
  description: string;
  created_at: number;
  updated_at: number;
}

export interface TopicWithCounts extends Topic {
  workstream_count: number;
  entry_count: number;
}

export interface TopicWorkstreamLink {
  workstream_id: number;
  workstream_slug: string;
  workstream_title: string;
  linked_at: number;
  /** 0 / 1 — whether this workstream currently has the topic in focus. */
  focused: number;
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

export interface WorkstreamTopicRow extends TopicWithCounts {
  linked_at: number;
  entry_count_in_workstream: number;
  /** 0 / 1 — whether this topic is currently focused in the workstream. */
  focused: number;
}

/**
 * Lazily require `node:sqlite` so any load-time error (e.g. missing
 * `--experimental-sqlite` flag on an old runtime) is caught by the
 * try/catch around `openJournalStore()` in `extension.ts` instead of
 * crashing the whole extension at import time.
 */
function loadSqlite(): typeof import('node:sqlite') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:sqlite');
}

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

export function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(' ');
}

function snippetBody(body: string, max = 200): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return collapsed.slice(0, max - 1).trimEnd() + '…';
}

// ---------------------------------------------------------------------------
// Migrations
// ---------------------------------------------------------------------------

interface Migration {
  version: number;
  file: string;
  /**
   * If true, the runner does NOT wrap this migration in BEGIN/COMMIT — the
   * migration file is expected to manage its own transaction (and any
   * `PRAGMA foreign_keys` toggles that have to live outside one). After the
   * migration runs, the runner performs `PRAGMA foreign_key_check` and
   * aborts the install if any rows are returned.
   */
  noWrap?: boolean;
}

const MIGRATIONS: Migration[] = [
  { version: 1, file: '001_initial.sql' },
  { version: 2, file: '002_soft_delete.sql' },
  { version: 3, file: '003_topics.sql' },
  { version: 4, file: '004_topic_status_open_closed.sql' },
  { version: 5, file: '005_safe_topic_rebuild_template.sql' },
  { version: 6, file: '006_topic_parents.sql' },
  { version: 7, file: '007_topic_type.sql' },
  { version: 8, file: '008_topic_types_table.sql' },
  // 009 rebuilds the `topics` table to add the FK on topic_type. Must run
  // unwrapped so `PRAGMA foreign_keys = OFF` actually takes effect; see
  // 005_safe_topic_rebuild_template.sql for the why.
  { version: 9, file: '009_topic_type_fk.sql', noWrap: true },
  { version: 10, file: '010_session_chat_ref.sql' },
  { version: 11, file: '011_workstream_topic_focus.sql' },
  { version: 12, file: '012_entries_created_by.sql' },
];

/**
 * Locate the `schema/` directory regardless of whether this file is
 * loaded from compiled JS (`out/src/db.js` → schema is `../../schema`)
 * or directly from TS during tests (`src/db.ts` → schema is `../schema`).
 */
function resolveSchemaDir(): string {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'schema'),
    path.resolve(__dirname, '..', 'schema'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, '001_initial.sql'))) {
      return c;
    }
  }
  throw new Error(
    `could not locate schema/ directory from ${__dirname} (tried: ${candidates.join(', ')})`,
  );
}

function runMigrations(instance: DatabaseSyncT, schemaDir: string): void {
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
    const sql = fs.readFileSync(path.join(schemaDir, m.file), 'utf8');
    if (m.noWrap) {
      instance.exec(sql);
      const violations = instance
        .prepare(`PRAGMA foreign_key_check`)
        .all() as unknown as Record<string, unknown>[];
      if (violations.length) {
        throw new Error(
          `migration ${m.file} left ${violations.length} foreign-key violation(s): ${JSON.stringify(violations)}`,
        );
      }
      instance
        .prepare(
          `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`,
        )
        .run(m.version, nowEpoch());
      continue;
    }
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

// ---------------------------------------------------------------------------
// Inputs / option shapes
// ---------------------------------------------------------------------------

export interface ListWorkstreamsOptions {
  status?: 'open' | 'closed' | 'all';
  includeDeleted?: boolean;
  orderBy?: 'opened-asc' | 'closed-desc' | 'last-activity-desc';
}

export interface CreateWorkstreamInput {
  slug: string;
  title: string;
  status?: 'open' | 'closed';
}

export interface UpdateWorkstreamInput {
  title?: string;
  status?: 'open' | 'closed';
  closure?: string;
}

export interface SoftDeleteResult {
  workstreams: number;
  sessions: number;
  entries: number;
}

export interface StartSessionInput {
  workstream_slug: string;
  summary?: string;
  session_id?: string;
  chat_ref?: string | null;
}

export interface AppendEntryInput {
  session_id: string;
  body: string;
  created_by: string;
  timestamp?: number;
}

export interface SearchEntriesInput {
  query: string;
  workstream_slug?: string;
  limit?: number;
}

export interface ListTopicsOptions {
  status?: TopicStatus | 'all';
  includeDeleted?: boolean;
  workstreamSlug?: string;
  topicType?: string;
}

export interface CreateTopicInput {
  slug: string;
  title?: string;
  body?: string;
  status?: TopicStatus;
  topic_type?: string;
}

export interface UpdateTopicInput {
  title?: string;
  body?: string;
  status?: TopicStatus;
  topic_type?: string;
}

export interface SoftDeleteTopicResult {
  topics: number;
  workstream_links: number;
  entry_links: number;
}

export interface LinkWorkstreamTopicInput {
  workstream_slug: string;
  topic_slug: string;
  /**
   * Optional focus override (workstream-focus-mechanism, migration 011).
   * - `true`  → set `focused = 1` on the link.
   * - `false` → set `focused = 0` (does NOT remove the link).
   * - omitted → preserve the existing focused value (just ensure the link).
   */
  focused?: boolean;
}

export interface LinkWorkstreamTopicResult {
  workstream_slug: string;
  topic_slug: string;
  topic_created: boolean;
  link_created: boolean;
  link_restored: boolean;
  linked_at: number;
  /** Resolved focus value on the link after the operation (0 or 1). */
  focused: number;
}

export interface UnlinkWorkstreamTopicResult {
  workstream_slug: string;
  topic_slug: string;
  removed: number;
}

export interface UnfocusWorkstreamResult {
  workstream_slug: string;
  cleared: number;
}

export interface UnfocusWorkstreamTopicResult {
  workstream_slug: string;
  topic_slug: string;
  cleared: number;
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

export interface UnlinkEntryTopicResult {
  entry_id: number;
  topic_slug: string;
  removed: number;
}

export interface AddTopicParentResult {
  child_slug: string;
  parent_slug: string;
  created_at: number;
  link_restored: boolean;
}

export interface RemoveTopicParentResult {
  child_slug: string;
  parent_slug: string;
  removed: number;
}

// ---------------------------------------------------------------------------
// JournalStore — the single owner of a live SQLite handle
// ---------------------------------------------------------------------------

export interface OpenJournalStoreOptions {
  /**
   * SQLite file path. Pass `':memory:'` for an ephemeral DB (used by tests).
   */
  dbPath: string;
}

/**
 * Open (or create) a SQLite DB at `dbPath`, apply any pending migrations,
 * and return a ready-to-use `JournalStore`. The schema directory is
 * resolved internally via `__dirname` — callers don't pass it.
 */
export function openJournalStore(
  opts: OpenJournalStoreOptions,
): JournalStore {
  const { dbPath } = opts;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const { DatabaseSync } = loadSqlite();
  const instance = new DatabaseSync(dbPath);
  // node:sqlite has no `.pragma()` helper — use exec().
  instance.exec('PRAGMA journal_mode = WAL');
  instance.exec('PRAGMA foreign_keys = ON');
  runMigrations(instance, resolveSchemaDir());
  return new JournalStore(instance, dbPath);
}

export class JournalStore {
  constructor(
    private readonly db: DatabaseSyncT,
    public readonly dbPath: string,
  ) {}

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Generic helpers
  // -------------------------------------------------------------------------

  private withTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Workstreams
  // -------------------------------------------------------------------------

  listWorkstreams(opts: ListWorkstreamsOptions = {}): WorkstreamWithCount[] {
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
    return this.db
      .prepare(sql)
      .all(...params) as unknown as WorkstreamWithCount[];
  }

  getWorkstreamBySlug(
    slug: string,
    includeDeleted = false,
  ): Workstream | null {
    const sql = `
      SELECT id, slug, title, status, opened_at, closed_at, closure, deleted_at
        FROM workstreams
        WHERE slug = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `;
    const row = this.db
      .prepare(sql)
      .get(slug) as unknown as Workstream | undefined;
    return row ?? null;
  }

  getWorkstreamById(id: number, includeDeleted = false): Workstream | null {
    const sql = `
      SELECT id, slug, title, status, opened_at, closed_at, closure, deleted_at
        FROM workstreams
        WHERE id = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `;
    const row = this.db
      .prepare(sql)
      .get(id) as unknown as Workstream | undefined;
    return row ?? null;
  }

  createWorkstream(input: CreateWorkstreamInput): Workstream {
    if (!input.slug || !input.title) {
      throw new Error('slug and title are required');
    }
    const existing = this.getWorkstreamBySlug(input.slug, true);
    if (existing) {
      const tag = existing.deleted_at ? ' (soft-deleted)' : '';
      throw new Error(`workstream slug already exists${tag}: ${input.slug}`);
    }
    const status = input.status ?? 'open';
    const opened = nowEpoch();
    const closed = status === 'closed' ? opened : null;
    this.db
      .prepare(
        `INSERT INTO workstreams (slug, title, status, opened_at, closed_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.slug, input.title, status, opened, closed);
    const row = this.getWorkstreamBySlug(input.slug);
    if (!row) {
      throw new Error('createWorkstream: insert succeeded but row not found');
    }
    return row;
  }

  updateWorkstream(slug: string, patch: UpdateWorkstreamInput): Workstream {
    const current = this.getWorkstreamBySlug(slug);
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
    this.db
      .prepare(`UPDATE workstreams SET ${sets.join(', ')} WHERE slug = ?`)
      .run(...params);
    const updated = this.getWorkstreamBySlug(slug);
    if (!updated) {
      throw new Error('updateWorkstream: row vanished after update');
    }
    return updated;
  }

  reopenWorkstream(slug: string): Workstream {
    const current = this.getWorkstreamBySlug(slug);
    if (!current) {
      throw new Error(`workstream not found: ${slug}`);
    }
    if (current.status === 'open' && current.closed_at === null) {
      return current;
    }
    this.db
      .prepare(
        `UPDATE workstreams
            SET status = 'open', closed_at = NULL
          WHERE slug = ?`,
      )
      .run(slug);
    const updated = this.getWorkstreamBySlug(slug);
    if (!updated) {
      throw new Error('reopenWorkstream: row vanished after update');
    }
    return updated;
  }

  softDeleteWorkstream(slug: string): SoftDeleteResult {
    const ws = this.getWorkstreamBySlug(slug);
    if (!ws) {
      throw new Error(`workstream not found: ${slug}`);
    }
    const ts = nowEpoch();

    return this.withTransaction(() => {
      const affectedEntries = this.db
        .prepare(
          `SELECT e.id, e.body
             FROM entries e
             JOIN sessions s ON e.session_id = s.session_id
             WHERE s.workstream_id = ?
               AND e.deleted_at IS NULL`,
        )
        .all(ws.id) as unknown as { id: number; body: string }[];

      const ftsDel = this.db.prepare(
        `INSERT INTO entries_fts(entries_fts, rowid, body) VALUES('delete', ?, ?)`,
      );
      for (const row of affectedEntries) {
        ftsDel.run(row.id, row.body);
      }

      const entryRes = this.db
        .prepare(
          `UPDATE entries
              SET deleted_at = ?
            WHERE deleted_at IS NULL
              AND session_id IN (SELECT session_id FROM sessions
                                   WHERE workstream_id = ?)`,
        )
        .run(ts, ws.id);
      const sessionRes = this.db
        .prepare(
          `UPDATE sessions SET deleted_at = ?
            WHERE workstream_id = ? AND deleted_at IS NULL`,
        )
        .run(ts, ws.id);
      const wsRes = this.db
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

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  listSessionsForWorkstream(
    workstreamId: number,
    includeDeleted = false,
  ): Session[] {
    const sql = `
      SELECT session_id, workstream_id, started_at, ended_at, summary,
             chat_ref, deleted_at
        FROM sessions
        WHERE workstream_id = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        ORDER BY started_at ASC
    `;
    return this.db.prepare(sql).all(workstreamId) as unknown as Session[];
  }

  getSession(sessionId: string, includeDeleted = false): Session | null {
    const sql = `
      SELECT session_id, workstream_id, started_at, ended_at, summary,
             chat_ref, deleted_at
        FROM sessions
        WHERE session_id = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `;
    const row = this.db
      .prepare(sql)
      .get(sessionId) as unknown as Session | undefined;
    return row ?? null;
  }

  getPreviousSessionInWorkstream(
    workstreamId: number,
    startedAt: number,
    sessionId: string,
  ): Session | null {
    const sql = `
      SELECT session_id, workstream_id, started_at, ended_at, summary,
             chat_ref, deleted_at
        FROM sessions
        WHERE workstream_id = ?
          AND deleted_at IS NULL
          AND session_id <> ?
          AND (started_at < ? OR (started_at = ? AND session_id < ?))
        ORDER BY started_at DESC, session_id DESC
        LIMIT 1
    `;
    const row = this.db
      .prepare(sql)
      .get(
        workstreamId,
        sessionId,
        startedAt,
        startedAt,
        sessionId,
      ) as unknown as Session | undefined;
    return row ?? null;
  }

  getNextSessionInWorkstream(
    workstreamId: number,
    startedAt: number,
    sessionId: string,
  ): Session | null {
    const sql = `
      SELECT session_id, workstream_id, started_at, ended_at, summary,
             chat_ref, deleted_at
        FROM sessions
        WHERE workstream_id = ?
          AND deleted_at IS NULL
          AND session_id <> ?
          AND (started_at > ? OR (started_at = ? AND session_id > ?))
        ORDER BY started_at ASC, session_id ASC
        LIMIT 1
    `;
    const row = this.db
      .prepare(sql)
      .get(
        workstreamId,
        sessionId,
        startedAt,
        startedAt,
        sessionId,
      ) as unknown as Session | undefined;
    return row ?? null;
  }

  listTopicsForSession(sessionId: string): Topic[] {
    const sql = `
      SELECT DISTINCT t.slug, t.title, t.status, t.topic_type, t.body,
             t.created_at, t.updated_at, t.deleted_at
        FROM entry_topics et
        JOIN entries e ON e.id = et.entry_id
        JOIN topics t  ON t.slug = et.topic_slug
        WHERE e.session_id = ?
          AND et.deleted_at IS NULL
          AND e.deleted_at IS NULL
          AND t.deleted_at IS NULL
        ORDER BY t.slug ASC
    `;
    return this.db.prepare(sql).all(sessionId) as unknown as Topic[];
  }

  listTopicsForEntry(entryId: number): Topic[] {
    const sql = `
      SELECT t.slug, t.title, t.status, t.topic_type, t.body,
             t.created_at, t.updated_at, t.deleted_at
        FROM entry_topics et
        JOIN topics t ON t.slug = et.topic_slug
        WHERE et.entry_id = ?
          AND et.deleted_at IS NULL
          AND t.deleted_at IS NULL
        ORDER BY t.slug ASC
    `;
    return this.db.prepare(sql).all(entryId) as unknown as Topic[];
  }

  startSession(input: StartSessionInput): Session {
    const ws = this.getWorkstreamBySlug(input.workstream_slug);
    if (!ws) {
      throw new Error(`workstream not found: ${input.workstream_slug}`);
    }
    const sessionId = input.session_id ?? randomUUID();
    const existing = this.getSession(sessionId, true);
    if (existing) {
      throw new Error(`session_id already exists: ${sessionId}`);
    }
    const chatRef =
      input.chat_ref !== undefined && input.chat_ref !== null
        ? String(input.chat_ref).trim() || null
        : null;
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, workstream_id, started_at, summary, chat_ref)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sessionId, ws.id, nowEpoch(), input.summary ?? null, chatRef);
    const row = this.getSession(sessionId);
    if (!row) {
      throw new Error('startSession: insert succeeded but row not found');
    }
    return row;
  }

  endSession(sessionId: string, summary?: string): Session {
    const current = this.getSession(sessionId);
    if (!current) {
      throw new Error(`session not found: ${sessionId}`);
    }
    if (summary !== undefined) {
      this.db
        .prepare(
          `UPDATE sessions SET ended_at = ?, summary = ? WHERE session_id = ?`,
        )
        .run(nowEpoch(), summary, sessionId);
    } else {
      this.db
        .prepare(`UPDATE sessions SET ended_at = ? WHERE session_id = ?`)
        .run(nowEpoch(), sessionId);
    }
    const updated = this.getSession(sessionId);
    if (!updated) {
      throw new Error('endSession: row vanished after update');
    }
    return updated;
  }

  softDeleteSession(sessionId: string): SoftDeleteResult {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`session not found: ${sessionId}`);
    }
    const ts = nowEpoch();

    return this.withTransaction(() => {
      const affectedEntries = this.db
        .prepare(
          `SELECT id, body FROM entries
            WHERE session_id = ? AND deleted_at IS NULL`,
        )
        .all(sessionId) as unknown as { id: number; body: string }[];

      const ftsDel = this.db.prepare(
        `INSERT INTO entries_fts(entries_fts, rowid, body) VALUES('delete', ?, ?)`,
      );
      for (const row of affectedEntries) {
        ftsDel.run(row.id, row.body);
      }

      const entryRes = this.db
        .prepare(
          `UPDATE entries SET deleted_at = ?
            WHERE session_id = ? AND deleted_at IS NULL`,
        )
        .run(ts, sessionId);
      const sessionRes = this.db
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

  // -------------------------------------------------------------------------
  // Entries
  // -------------------------------------------------------------------------

  listEntriesForSession(sessionId: string, includeDeleted = false): Entry[] {
    const sql = `
      SELECT id, session_id, timestamp, body, created_by, deleted_at
        FROM entries
        WHERE session_id = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        ORDER BY timestamp ASC, id ASC
    `;
    return this.db.prepare(sql).all(sessionId) as unknown as Entry[];
  }

  appendEntry(input: AppendEntryInput): Entry {
    if (!input.body || !input.body.trim()) {
      throw new Error('body is required');
    }
    if (!input.created_by || !input.created_by.trim()) {
      throw new Error('created_by is required');
    }
    if (input.created_by.endsWith('*')) {
      throw new Error(
        'created_by must not end with "*" — that suffix is reserved for migrated rows',
      );
    }
    const session = this.getSession(input.session_id);
    if (!session) {
      throw new Error(`session not found: ${input.session_id}`);
    }
    const ts = input.timestamp ?? nowEpoch();
    const result = this.db
      .prepare(
        `INSERT INTO entries (session_id, timestamp, body, created_by)
         VALUES (?, ?, ?, ?)`,
      )
      .run(input.session_id, ts, input.body, input.created_by);
    const id = Number(result.lastInsertRowid);
    return {
      id,
      session_id: input.session_id,
      timestamp: ts,
      body: input.body,
      created_by: input.created_by,
      deleted_at: null,
    };
  }

  searchEntries(input: SearchEntriesInput): SearchHit[] {
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
      SELECT e.id, e.session_id, e.timestamp, e.body, e.created_by,
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
    return this.db.prepare(sql).all(...params) as unknown as SearchHit[];
  }

  softDeleteEntry(entryId: number): SoftDeleteResult {
    const row = this.db
      .prepare(
        `SELECT id, body FROM entries WHERE id = ? AND deleted_at IS NULL`,
      )
      .get(entryId) as unknown as { id: number; body: string } | undefined;
    if (!row) {
      throw new Error(`entry not found (or already deleted): ${entryId}`);
    }

    return this.withTransaction(() => {
      this.db
        .prepare(
          `INSERT INTO entries_fts(entries_fts, rowid, body) VALUES('delete', ?, ?)`,
        )
        .run(row.id, row.body);
      const res = this.db
        .prepare(`UPDATE entries SET deleted_at = ? WHERE id = ?`)
        .run(nowEpoch(), entryId);
      return {
        workstreams: 0,
        sessions: 0,
        entries: Number(res.changes),
      };
    });
  }

  // -------------------------------------------------------------------------
  // Topic types
  // -------------------------------------------------------------------------

  listTopicTypes(): TopicType[] {
    const sql = `
      SELECT id, label, icon, description, created_at, updated_at
        FROM topic_types
        ORDER BY id ASC
    `;
    return this.db.prepare(sql).all() as unknown as TopicType[];
  }

  listTopicTypeIds(): string[] {
    const rows = this.db
      .prepare(`SELECT id FROM topic_types ORDER BY id ASC`)
      .all() as unknown as { id: string }[];
    return rows.map((r) => r.id);
  }

  topicTypeExists(id: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS x FROM topic_types WHERE id = ?`)
      .get(id);
    return Boolean(row);
  }

  private assertValidTopicType(value: string): void {
    if (this.topicTypeExists(value)) {
      return;
    }
    const ids = this.listTopicTypeIds();
    throw new Error(
      `invalid topic_type: ${value} (must be one of ${ids.join(', ')})`,
    );
  }

  // -------------------------------------------------------------------------
  // Topics
  // -------------------------------------------------------------------------

  listTopics(opts: ListTopicsOptions = {}): TopicWithCounts[] {
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
      this.assertValidTopicType(opts.topicType);
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
    return this.db
      .prepare(sql)
      .all(...params) as unknown as TopicWithCounts[];
  }

  getTopic(slug: string, includeDeleted = false): Topic | null {
    const sql = `
      SELECT slug, title, status, topic_type, body, created_at, updated_at, deleted_at
        FROM topics
        WHERE slug = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
    `;
    const row = this.db
      .prepare(sql)
      .get(slug) as unknown as Topic | undefined;
    return row ?? null;
  }

  createTopic(input: CreateTopicInput): Topic {
    if (!input.slug || !input.slug.trim()) {
      throw new Error('slug is required');
    }
    const existing = this.getTopic(input.slug, true);
    if (existing) {
      const tag = existing.deleted_at ? ' (soft-deleted)' : '';
      throw new Error(`topic slug already exists${tag}: ${input.slug}`);
    }
    let topicType: string = DEFAULT_TOPIC_TYPE;
    if (input.topic_type !== undefined) {
      this.assertValidTopicType(input.topic_type);
      topicType = input.topic_type;
    }
    const now = nowEpoch();
    const title = input.title?.trim() || humanizeSlug(input.slug);
    const status = input.status ?? 'open';
    this.db
      .prepare(
        `INSERT INTO topics (slug, title, status, topic_type, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.slug, title, status, topicType, input.body ?? '', now, now);
    const row = this.getTopic(input.slug);
    if (!row) {
      throw new Error('createTopic: insert succeeded but row not found');
    }
    return row;
  }

  updateTopic(slug: string, patch: UpdateTopicInput): Topic {
    const current = this.getTopic(slug);
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
      this.assertValidTopicType(patch.topic_type);
      sets.push('topic_type = ?');
      params.push(patch.topic_type);
    }
    if (!sets.length) {
      return current;
    }
    sets.push('updated_at = ?');
    params.push(nowEpoch());
    params.push(slug);
    this.db
      .prepare(`UPDATE topics SET ${sets.join(', ')} WHERE slug = ?`)
      .run(...params);
    const updated = this.getTopic(slug);
    if (!updated) {
      throw new Error('updateTopic: row vanished after update');
    }
    return updated;
  }

  softDeleteTopic(slug: string): SoftDeleteTopicResult {
    const topic = this.getTopic(slug);
    if (!topic) {
      throw new Error(`topic not found: ${slug}`);
    }
    const ts = nowEpoch();
    return this.withTransaction(() => {
      const t = this.db
        .prepare(`UPDATE topics SET deleted_at = ? WHERE slug = ?`)
        .run(ts, slug);
      const w = this.db
        .prepare(
          `UPDATE workstream_topics SET deleted_at = ?
             WHERE topic_slug = ? AND deleted_at IS NULL`,
        )
        .run(ts, slug);
      const e = this.db
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

  // -------------------------------------------------------------------------
  // Topic linking
  // -------------------------------------------------------------------------

  private ensureWorkstreamTopicLink(
    workstreamId: number,
    topicSlug: string,
    now: number,
  ): { link_created: boolean; link_restored: boolean; linked_at: number } {
    const existing = this.db
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
      this.db
        .prepare(
          `UPDATE workstream_topics
              SET deleted_at = NULL, created_at = ?
            WHERE workstream_id = ? AND topic_slug = ?`,
        )
        .run(now, workstreamId, topicSlug);
      return { link_created: false, link_restored: true, linked_at: now };
    }
    this.db
      .prepare(
        `INSERT INTO workstream_topics (workstream_id, topic_slug, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(workstreamId, topicSlug, now);
    return { link_created: true, link_restored: false, linked_at: now };
  }

  private ensureTopicStub(slug: string, now: number): { created: boolean } {
    const existing = this.db
      .prepare(`SELECT deleted_at FROM topics WHERE slug = ?`)
      .get(slug) as unknown as { deleted_at: number | null } | undefined;
    if (existing) {
      if (existing.deleted_at !== null) {
        this.db
          .prepare(
            `UPDATE topics SET deleted_at = NULL, updated_at = ? WHERE slug = ?`,
          )
          .run(now, slug);
      }
      return { created: false };
    }
    this.db
      .prepare(
        `INSERT INTO topics (slug, title, status, body, created_at, updated_at)
         VALUES (?, ?, 'open', '', ?, ?)`,
      )
      .run(slug, humanizeSlug(slug), now, now);
    return { created: true };
  }

  linkWorkstreamTopic(
    input: LinkWorkstreamTopicInput,
  ): LinkWorkstreamTopicResult {
    const ws = this.getWorkstreamBySlug(input.workstream_slug);
    if (!ws) {
      throw new Error(
        `workstream not found (or soft-deleted): ${input.workstream_slug}`,
      );
    }
    return this.withTransaction(() => {
      const now = nowEpoch();
      const stub = this.ensureTopicStub(input.topic_slug, now);
      const link = this.ensureWorkstreamTopicLink(
        ws.id,
        input.topic_slug,
        now,
      );
      // Resolve focus: explicit input wins; otherwise read whatever's on the row
      // (the link row was just ensured to exist above, so SELECT is safe).
      let focused: number;
      if (input.focused !== undefined) {
        focused = input.focused ? 1 : 0;
        this.db
          .prepare(
            `UPDATE workstream_topics SET focused = ?
               WHERE workstream_id = ? AND topic_slug = ?`,
          )
          .run(focused, ws.id, input.topic_slug);
      } else {
        const row = this.db
          .prepare(
            `SELECT focused FROM workstream_topics
              WHERE workstream_id = ? AND topic_slug = ?`,
          )
          .get(ws.id, input.topic_slug) as unknown as
          | { focused: number }
          | undefined;
        focused = row?.focused ?? 0;
      }
      return {
        workstream_slug: ws.slug,
        topic_slug: input.topic_slug,
        topic_created: stub.created,
        link_created: link.link_created,
        link_restored: link.link_restored,
        linked_at: link.linked_at,
        focused,
      };
    });
  }

  unlinkWorkstreamTopic(
    input: LinkWorkstreamTopicInput,
  ): UnlinkWorkstreamTopicResult {
    const ws = this.getWorkstreamBySlug(input.workstream_slug, true);
    if (!ws) {
      throw new Error(`workstream not found: ${input.workstream_slug}`);
    }
    const res = this.db
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

  unfocusWorkstream(workstream_slug: string): UnfocusWorkstreamResult {
    const ws = this.getWorkstreamBySlug(workstream_slug);
    if (!ws) {
      throw new Error(`workstream not found: ${workstream_slug}`);
    }
    const res = this.db
      .prepare(
        `UPDATE workstream_topics
            SET focused = 0
          WHERE workstream_id = ?
            AND deleted_at IS NULL
            AND focused <> 0`,
      )
      .run(ws.id);
    return {
      workstream_slug: ws.slug,
      cleared: Number(res.changes),
    };
  }

  unfocusWorkstreamTopic(
    input: LinkWorkstreamTopicInput,
  ): UnfocusWorkstreamTopicResult {
    const ws = this.getWorkstreamBySlug(input.workstream_slug);
    if (!ws) {
      throw new Error(`workstream not found: ${input.workstream_slug}`);
    }
    const res = this.db
      .prepare(
        `UPDATE workstream_topics
            SET focused = 0
          WHERE workstream_id = ?
            AND topic_slug = ?
            AND deleted_at IS NULL
            AND focused <> 0`,
      )
      .run(ws.id, input.topic_slug);
    return {
      workstream_slug: ws.slug,
      topic_slug: input.topic_slug,
      cleared: Number(res.changes),
    };
  }

  linkEntryTopic(input: LinkEntryTopicInput): LinkEntryTopicResult {
    const row = this.db
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

    return this.withTransaction(() => {
      const now = nowEpoch();
      const stub = this.ensureTopicStub(input.topic_slug, now);

      const existingEntryLink = this.db
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
        this.db
          .prepare(
            `INSERT INTO entry_topics (entry_id, topic_slug, created_at)
             VALUES (?, ?, ?)`,
          )
          .run(input.entry_id, input.topic_slug, now);
        entry_link_created = true;
      } else if (existingEntryLink.deleted_at !== null) {
        this.db
          .prepare(
            `UPDATE entry_topics SET deleted_at = NULL, created_at = ?
              WHERE entry_id = ? AND topic_slug = ?`,
          )
          .run(now, input.entry_id, input.topic_slug);
        entry_link_restored = true;
      } else {
        linked_at = existingEntryLink.created_at;
      }

      const wsLink = this.ensureWorkstreamTopicLink(
        row.workstream_id,
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

  unlinkEntryTopic(input: LinkEntryTopicInput): UnlinkEntryTopicResult {
    const res = this.db
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

  // -------------------------------------------------------------------------
  // Topic query helpers
  // -------------------------------------------------------------------------

  listWorkstreamsForTopic(topicSlug: string): TopicWorkstreamLink[] {
    const sql = `
      SELECT w.id AS workstream_id, w.slug AS workstream_slug,
             w.title AS workstream_title, wt.created_at AS linked_at,
             wt.focused AS focused
        FROM workstream_topics wt
        JOIN workstreams w ON w.id = wt.workstream_id
        WHERE wt.topic_slug = ?
          AND wt.deleted_at IS NULL
          AND w.deleted_at IS NULL
        ORDER BY wt.created_at DESC, w.slug ASC
    `;
    return this.db
      .prepare(sql)
      .all(topicSlug) as unknown as TopicWorkstreamLink[];
  }

  listEntriesForTopic(topicSlug: string, limit = 25): TopicEntryLink[] {
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
    const rows = this.db.prepare(sql).all(topicSlug, limit) as unknown as ({
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

  listTopicsForWorkstream(workstreamId: number): WorkstreamTopicRow[] {
    const sql = `
      SELECT t.slug, t.title, t.status, t.topic_type, t.body,
             t.created_at, t.updated_at, t.deleted_at,
             wt.created_at AS linked_at,
             wt.focused AS focused,
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
    return this.db
      .prepare(sql)
      .all(workstreamId, workstreamId) as unknown as WorkstreamTopicRow[];
  }

  // -------------------------------------------------------------------------
  // Topic parents (DAG)
  // -------------------------------------------------------------------------

  listTopicParents(slug: string): Topic[] {
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
    return this.db.prepare(sql).all(slug) as unknown as Topic[];
  }

  listTopicChildren(slug: string): Topic[] {
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
    return this.db.prepare(sql).all(slug) as unknown as Topic[];
  }

  addTopicParent(
    childSlug: string,
    parentSlug: string,
  ): AddTopicParentResult {
    if (childSlug === parentSlug) {
      throw new Error(`cannot link a topic to itself: ${childSlug}`);
    }
    const child = this.getTopic(childSlug);
    if (!child) {
      throw new Error(`child topic not found (or soft-deleted): ${childSlug}`);
    }
    const parent = this.getTopic(parentSlug);
    if (!parent) {
      throw new Error(
        `parent topic not found (or soft-deleted): ${parentSlug}`,
      );
    }

    return this.withTransaction(() => {
      const cycleHit = this.db
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
      const existing = this.db
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
        this.db
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
      this.db
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

  removeTopicParent(
    childSlug: string,
    parentSlug: string,
  ): RemoveTopicParentResult {
    const res = this.db
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
}
