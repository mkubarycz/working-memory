/**
 * SQLite store owner for the control-plane service.
 *
 * The service — not the extension — owns the database handle. On open it puts
 * the database in WAL mode and ensures the resource schema (v1): a single
 * unified `resources` table (k8s-style envelope: kind + spec + status) plus a
 * `store_meta` counter that mints a global, monotonic `resource_version`.
 * Edges / events / FTS and update/delete are later phases.
 *
 * Follows the repo convention (see src/db.ts): `node:sqlite` is required
 * **lazily inside the open function** so a runtime that lacks it surfaces as a
 * caught, explanatory error here instead of crashing at import time. The
 * DatabaseSync API has no `.pragma()` / `.transaction()` helpers, so we use
 * `db.exec('PRAGMA ...')` and hand-rolled `BEGIN IMMEDIATE` / `COMMIT` /
 * `ROLLBACK`. `.all()` / `.get()` type as `unknown`, so results are cast.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** The parsed, caller-facing document envelope. */
export interface DocumentEnvelope {
  kind: string;
  metadata: {
    id: string;
    slug: string | null;
    labels: Record<string, string>;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
    resourceVersion: number;
  };
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
}

export interface CreateDocumentInput {
  kind: string;
  slug?: string | null;
  labels?: Record<string, string>;
  spec?: Record<string, unknown>;
  /** Optional initial status (controller-owned). Defaults to `{}`. */
  status?: Record<string, unknown>;
}

export interface ListDocumentsInput {
  kind?: string;
}

export interface GetDocumentInput {
  id?: string;
  slug?: string;
  kind?: string;
  /**
   * When true, a by-id / by-slug read also matches a soft-deleted row. Used to
   * locate a document by slug in order to undelete it (restore is by id, but
   * the caller only knows the slug). Defaults to false (live rows only).
   */
  includeDeleted?: boolean;
}

export interface UpdateDocumentInput {
  id: string;
  /** The resource_version the caller believes is current (CAS guard). */
  expectedResourceVersion: number;
  /**
   * The already-parsed, already-merged full spec to persist. The
   * `wm-document-update` tool computes this by shallow-merging the caller's
   * partial patch onto the current spec and validating the result; the store
   * always writes the full spec it's handed.
   */
  spec: Record<string, unknown>;
  /**
   * Optional new slug (replace-if-provided). When omitted the `slug` column is
   * left unchanged; when provided (including `null`) it overwrites.
   */
  slug?: string | null;
  /**
   * Optional new labels (replace-if-provided). When omitted the `labels` column
   * is left unchanged; when provided it replaces the whole labels object.
   */
  labels?: Record<string, string>;
  /**
   * Optional new status (controller-owned). The human `wm-document-update` tool
   * never passes this; it's reserved for controllers doing status writes.
   */
  status?: Record<string, unknown>;
}

export interface DeleteDocumentInput {
  id: string;
  /**
   * Optional CAS guard. When provided, the soft-delete only happens if the live
   * row still carries this version (a mismatch throws `ConflictError`). When
   * omitted, the current live row is soft-deleted unconditionally. Delete is a
   * terminal op with low lost-update risk, so the guard is opt-in.
   */
  expectedResourceVersion?: number;
}

export interface RestoreDocumentInput {
  id: string;
}

/**
 * Thrown when a live row with the given id exists but its `resource_version`
 * doesn't match the caller's `expected` (a stale writer). Carries the current
 * version so the caller can report it and prompt a re-fetch + retry.
 */
export class ConflictError extends Error {
  readonly id: string;
  readonly expectedResourceVersion: number;
  readonly currentResourceVersion: number;
  constructor(id: string, expectedResourceVersion: number, currentResourceVersion: number) {
    super(
      `Conflict updating document ${id}: expected resourceVersion ` +
        `${expectedResourceVersion} but current is ${currentResourceVersion}.`,
    );
    this.name = 'ConflictError';
    this.id = id;
    this.expectedResourceVersion = expectedResourceVersion;
    this.currentResourceVersion = currentResourceVersion;
  }
}

/** Thrown when no live (non-deleted) row exists for the given id. */
export class NotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`No live document with id ${id}.`);
    this.name = 'NotFoundError';
    this.id = id;
  }
}

export interface Store {
  /**
   * Soft-delete a document by stamping `deleted_at` (bumps the global
   * `resource_version`). **Kind-agnostic** — no kind lookup / spec validation,
   * so legacy or unregistered-kind documents are deletable. `expectedResourceVersion`
   * is optional: when provided it CAS-guards (throws `ConflictError` on a version
   * mismatch), when omitted the current live row is soft-deleted unconditionally.
   * Throws `NotFoundError` when no live row exists (unknown or already-deleted id).
   */
  deleteDocument(input: DeleteDocumentInput): DocumentEnvelope;
  /**
   * Restore a soft-deleted document by clearing `deleted_at` (bumps the global
   * `resource_version`). Kind-agnostic. Throws `NotFoundError` when no
   * soft-deleted row exists for the id (unknown or already-live).
   */
  restoreDocument(input: RestoreDocumentInput): DocumentEnvelope;
  readonly db: DatabaseSync;
  readonly path: string;
  /** Insert a new document; bumps the global `resource_version`. */
  createDocument(input: CreateDocumentInput): DocumentEnvelope;
  /** List non-deleted documents (newest first), optionally filtered by kind. */
  listDocuments(input?: ListDocumentsInput): DocumentEnvelope[];
  /** Fetch one document by id, or by slug (optionally scoped by kind). Live rows
   * only unless `includeDeleted` is set (used to locate a doc for undelete). */
  getDocument(input: GetDocumentInput): DocumentEnvelope | null;
  /**
   * Compare-and-swap update of a document's spec (and optionally slug, labels,
   * status). Bumps the global `resource_version` and conditionally writes only
   * when the row's current version matches `expectedResourceVersion`. `slug` and
   * `labels` are replace-if-provided (omitted → column unchanged). Throws
   * `ConflictError` on a version mismatch and `NotFoundError` when no live row
   * exists.
   */
  updateDocument(input: UpdateDocumentInput): DocumentEnvelope;
  close(): void;
}

/** Raw row shape as stored in the `resources` table. */
interface ResourceRow {
  id: string;
  kind: string;
  slug: string | null;
  labels: string;
  spec: string;
  status: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  resource_version: number;
}

function loadSqlite(): typeof import('node:sqlite') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:sqlite');
  } catch (err) {
    throw new Error(
      'node:sqlite is unavailable in this runtime (need Node >= 22.5, ' +
        'possibly launched with --experimental-sqlite). ' +
        `Original error: ${(err as Error).message}`,
    );
  }
}

/** Current unix time in whole seconds (the store's timestamp unit). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Idempotently create the resource schema (safe to run on every open). */
function ensureSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resources (
      id               TEXT PRIMARY KEY,
      kind             TEXT NOT NULL,
      slug             TEXT,
      labels           TEXT NOT NULL DEFAULT '{}',
      spec             TEXT NOT NULL DEFAULT '{}',
      status           TEXT NOT NULL DEFAULT '{}',
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL,
      deleted_at       INTEGER,
      resource_version INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS store_meta (
      key   TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );

    INSERT OR IGNORE INTO store_meta (key, value) VALUES ('resource_version', 0);

    CREATE INDEX IF NOT EXISTS idx_resources_kind ON resources (kind);
  `);
}

/** Safely JSON-parse a stored object column, defaulting to `{}` on any error. */
function parseObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function rowToEnvelope(row: ResourceRow): DocumentEnvelope {
  return {
    kind: row.kind,
    metadata: {
      id: row.id,
      slug: row.slug ?? null,
      labels: parseObject(row.labels) as Record<string, string>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at ?? null,
      resourceVersion: row.resource_version,
    },
    spec: parseObject(row.spec),
    status: parseObject(row.status),
  };
}

/**
 * Open (creating if needed) the control-plane SQLite store, enable WAL, and
 * ensure the resource schema. Pass `':memory:'` for an ephemeral database.
 */
export function openStore(dbFilePath: string): Store {
  const sqlite = loadSqlite();

  if (dbFilePath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
  }

  const db = new sqlite.DatabaseSync(dbFilePath);
  // No `.pragma()` helper on DatabaseSync — use exec (repo convention).
  db.exec('PRAGMA journal_mode = WAL');
  ensureSchema(db);

  function createDocument(input: CreateDocumentInput): DocumentEnvelope {
    const now = nowSeconds();
    const id = randomUUID();
    const slug = input.slug ?? null;
    const labels = input.labels ?? {};
    const spec = input.spec ?? {};
    const status = input.status ?? {};
    const labelsJson = JSON.stringify(labels);
    const specJson = JSON.stringify(spec);
    const statusJson = JSON.stringify(status);

    // BEGIN IMMEDIATE so the version bump + insert are one atomic unit and take
    // the write lock up front (single-writer model).
    db.exec('BEGIN IMMEDIATE');
    let resourceVersion: number;
    try {
      db.prepare(
        "UPDATE store_meta SET value = value + 1 WHERE key = 'resource_version'",
      ).run();
      const counter = db
        .prepare("SELECT value FROM store_meta WHERE key = 'resource_version'")
        .get() as unknown as { value: number } | undefined;
      resourceVersion = counter?.value ?? 0;

      db.prepare(
        `INSERT INTO resources
           (id, kind, slug, labels, spec, status, created_at, updated_at, deleted_at, resource_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      ).run(id, input.kind, slug, labelsJson, specJson, statusJson, now, now, resourceVersion);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return {
      kind: input.kind,
      metadata: {
        id,
        slug,
        labels: labels as Record<string, string>,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        resourceVersion,
      },
      spec,
      status,
    };
  }

  function listDocuments(input: ListDocumentsInput = {}): DocumentEnvelope[] {
    const rows = (
      input.kind
        ? db
            .prepare(
              `SELECT * FROM resources
               WHERE deleted_at IS NULL AND kind = ?
               ORDER BY updated_at DESC, rowid DESC`,
            )
            .all(input.kind)
        : db
            .prepare(
              `SELECT * FROM resources
               WHERE deleted_at IS NULL
               ORDER BY updated_at DESC, rowid DESC`,
            )
            .all()
    ) as unknown as ResourceRow[];
    return rows.map(rowToEnvelope);
  }

  function getDocument(input: GetDocumentInput): DocumentEnvelope | null {
    // `includeDeleted` drops the live-only filter so a soft-deleted row can be
    // located (e.g. to undelete it by slug). Defaults to live-only.
    const deletedClause = input.includeDeleted === true ? '' : ' AND deleted_at IS NULL';
    let row: ResourceRow | undefined;
    if (input.id) {
      row = db
        .prepare(`SELECT * FROM resources WHERE id = ?${deletedClause}`)
        .get(input.id) as unknown as ResourceRow | undefined;
    } else if (input.slug !== undefined) {
      row = (
        input.kind
          ? db
              .prepare(
                `SELECT * FROM resources WHERE slug = ? AND kind = ?${deletedClause} ORDER BY updated_at DESC LIMIT 1`,
              )
              .get(input.slug, input.kind)
          : db
              .prepare(
                `SELECT * FROM resources WHERE slug = ?${deletedClause} ORDER BY updated_at DESC LIMIT 1`,
              )
              .get(input.slug)
      ) as unknown as ResourceRow | undefined;
    }
    return row ? rowToEnvelope(row) : null;
  }

  function updateDocument(input: UpdateDocumentInput): DocumentEnvelope {
    const now = nowSeconds();
    const specJson = JSON.stringify(input.spec);
    const hasStatus = input.status !== undefined;
    const hasSlug = input.slug !== undefined;
    const hasLabels = input.labels !== undefined;

    // BEGIN IMMEDIATE so the version bump + conditional update are one atomic
    // unit under the write lock (single-writer model).
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        "UPDATE store_meta SET value = value + 1 WHERE key = 'resource_version'",
      ).run();
      const counter = db
        .prepare("SELECT value FROM store_meta WHERE key = 'resource_version'")
        .get() as unknown as { value: number } | undefined;
      const next = counter?.value ?? 0;

      // Build the SET clause from the always-written columns plus any optional
      // replace-if-provided columns (slug / labels / status). Params are pushed
      // in the same order as the `?` placeholders, followed by the CAS WHERE
      // params. `changes === 0` means either a version mismatch or no live row.
      const setCols = ['spec = ?', 'updated_at = ?', 'resource_version = ?'];
      const params: unknown[] = [specJson, now, next];
      if (hasSlug) {
        setCols.push('slug = ?');
        params.push(input.slug ?? null);
      }
      if (hasLabels) {
        setCols.push('labels = ?');
        params.push(JSON.stringify(input.labels));
      }
      if (hasStatus) {
        setCols.push('status = ?');
        params.push(JSON.stringify(input.status));
      }
      params.push(input.id, input.expectedResourceVersion);

      const sql = `UPDATE resources
             SET ${setCols.join(', ')}
           WHERE id = ? AND resource_version = ? AND deleted_at IS NULL`;
      const result = db.prepare(sql).run(...(params as never[]));

      if (Number(result.changes) === 0) {
        // Distinguish not-found from version-mismatch by reading the live row.
        const live = db
          .prepare('SELECT resource_version FROM resources WHERE id = ? AND deleted_at IS NULL')
          .get(input.id) as unknown as { resource_version: number } | undefined;
        db.exec('ROLLBACK');
        if (!live) {
          throw new NotFoundError(input.id);
        }
        throw new ConflictError(input.id, input.expectedResourceVersion, live.resource_version);
      }

      const updated = db
        .prepare('SELECT * FROM resources WHERE id = ?')
        .get(input.id) as unknown as ResourceRow;
      db.exec('COMMIT');
      return rowToEnvelope(updated);
    } catch (err) {
      // ConflictError/NotFoundError already rolled back above; guard the rest.
      if (!(err instanceof ConflictError) && !(err instanceof NotFoundError)) {
        db.exec('ROLLBACK');
      }
      throw err;
    }
  }

  function deleteDocument(input: DeleteDocumentInput): DocumentEnvelope {
    const now = nowSeconds();
    const hasExpected = input.expectedResourceVersion !== undefined;

    // BEGIN IMMEDIATE so the version bump + conditional soft-delete are one
    // atomic unit under the write lock (single-writer model). No kind lookup or
    // spec validation here — delete is deliberately kind-agnostic so legacy /
    // unregistered-kind documents remain deletable.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        "UPDATE store_meta SET value = value + 1 WHERE key = 'resource_version'",
      ).run();
      const counter = db
        .prepare("SELECT value FROM store_meta WHERE key = 'resource_version'")
        .get() as unknown as { value: number } | undefined;
      const next = counter?.value ?? 0;

      // Stamp deleted_at only on a live row. When an expected version is given,
      // it's part of the WHERE (CAS); otherwise we soft-delete unconditionally.
      const sql = hasExpected
        ? `UPDATE resources
             SET deleted_at = ?, updated_at = ?, resource_version = ?
           WHERE id = ? AND deleted_at IS NULL AND resource_version = ?`
        : `UPDATE resources
             SET deleted_at = ?, updated_at = ?, resource_version = ?
           WHERE id = ? AND deleted_at IS NULL`;
      const result = hasExpected
        ? db
            .prepare(sql)
            .run(now, now, next, input.id, input.expectedResourceVersion as number)
        : db.prepare(sql).run(now, now, next, input.id);

      if (Number(result.changes) === 0) {
        // Distinguish not-found from version-mismatch by reading the live row.
        // A mismatch is only possible when an expected version was supplied.
        const live = db
          .prepare('SELECT resource_version FROM resources WHERE id = ? AND deleted_at IS NULL')
          .get(input.id) as unknown as { resource_version: number } | undefined;
        db.exec('ROLLBACK');
        if (!live) {
          throw new NotFoundError(input.id);
        }
        throw new ConflictError(
          input.id,
          input.expectedResourceVersion as number,
          live.resource_version,
        );
      }

      const deleted = db
        .prepare('SELECT * FROM resources WHERE id = ?')
        .get(input.id) as unknown as ResourceRow;
      db.exec('COMMIT');
      return rowToEnvelope(deleted);
    } catch (err) {
      // ConflictError/NotFoundError already rolled back above; guard the rest.
      if (!(err instanceof ConflictError) && !(err instanceof NotFoundError)) {
        db.exec('ROLLBACK');
      }
      throw err;
    }
  }

  function restoreDocument(input: RestoreDocumentInput): DocumentEnvelope {
    const now = nowSeconds();

    // BEGIN IMMEDIATE so the version bump + conditional restore are one atomic
    // unit under the write lock. Kind-agnostic, mirroring deleteDocument.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        "UPDATE store_meta SET value = value + 1 WHERE key = 'resource_version'",
      ).run();
      const counter = db
        .prepare("SELECT value FROM store_meta WHERE key = 'resource_version'")
        .get() as unknown as { value: number } | undefined;
      const next = counter?.value ?? 0;

      // Clear deleted_at only on a currently soft-deleted row.
      const result = db
        .prepare(
          `UPDATE resources
             SET deleted_at = NULL, updated_at = ?, resource_version = ?
           WHERE id = ? AND deleted_at IS NOT NULL`,
        )
        .run(now, next, input.id);

      if (Number(result.changes) === 0) {
        // No soft-deleted row for this id: unknown id or it's already live.
        db.exec('ROLLBACK');
        throw new NotFoundError(input.id);
      }

      // getDocument filters out deleted rows, but this row is now live; still,
      // read it directly by id to build the restored envelope.
      const restored = db
        .prepare('SELECT * FROM resources WHERE id = ?')
        .get(input.id) as unknown as ResourceRow;
      db.exec('COMMIT');
      return rowToEnvelope(restored);
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        db.exec('ROLLBACK');
      }
      throw err;
    }
  }

  return {
    db,
    path: dbFilePath,
    createDocument,
    listDocuments,
    getDocument,
    updateDocument,
    deleteDocument,
    restoreDocument,
    close(): void {
      db.close();
    },
  };
}
