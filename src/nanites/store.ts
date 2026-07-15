import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import {
  type CreateNaniteInput,
  type ListNanitesInput,
  type Nanite,
  type NaniteRun,
  type NaniteRunStatus,
  type RestoreNaniteResult,
  type SoftDeleteNaniteResult,
  type UpdateNaniteInput,
} from './types';

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Single on/off switch for the entire nanites feature. Flip to `false` and the
 * whole feature — every `wm_*nanite*` tool — stops registering. (The migration
 * and the static `package.json` tool declarations are inert manifest data and
 * stay put; nothing wires up at runtime when this is off.)
 */
export const NANITES_ENABLED = true;

interface NaniteRow {
  id: number;
  slug: string;
  title: string;
  kind: string;
  trigger_phrase: string;
  instructions: string;
  model: string | null;
  tool_allowlist: string;
  input_schema: string | null;
  output_schema: string | null;
  enabled: number;
  acceptance_criteria: string;
  acceptance_threshold: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

interface NaniteRunRow {
  id: number;
  nanite_id: number;
  status: NaniteRunStatus;
  started_at: number | null;
  ended_at: number | null;
  result: string | null;
  error: string | null;
  created_at: number;
}

function parseAllowlist(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    // fall through to empty
  }
  return [];
}

function hydrateNanite(row: NaniteRow): Nanite {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kind: row.kind,
    trigger_phrase: row.trigger_phrase,
    instructions: row.instructions,
    model: row.model,
    tool_allowlist: parseAllowlist(row.tool_allowlist),
    input_schema: row.input_schema,
    output_schema: row.output_schema,
    enabled: row.enabled === 1,
    acceptance_criteria: row.acceptance_criteria,
    acceptance_threshold: row.acceptance_threshold,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at,
  };
}

function hydrateRun(row: NaniteRunRow): NaniteRun {
  let result: unknown = null;
  if (row.result) {
    try {
      result = JSON.parse(row.result);
    } catch {
      result = row.result;
    }
  }
  return {
    id: row.id,
    nanite_id: row.nanite_id,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    result,
    error: row.error,
    created_at: row.created_at,
  };
}

const NANITE_COLS = `id, slug, title, kind, trigger_phrase, instructions, model,
  tool_allowlist, input_schema, output_schema, enabled,
  acceptance_criteria, acceptance_threshold,
  created_at, updated_at, deleted_at`;

const RUN_COLS = `id, nanite_id, status, started_at, ended_at, result, error, created_at`;

/**
 * Self-contained data layer for the nanites feature. Wraps a raw `node:sqlite`
 * handle (obtained via `JournalStore.connection`) rather than extending
 * `JournalStore`, so the whole feature stays under `src/nanites/`.
 *
 * Defensive contract (mirrors the rest of the codebase): read paths return
 * `[]` / `null` when the DB handle is missing and never throw; write paths
 * throw a clear error.
 */
export class NanitesStore {
  constructor(private readonly db: DatabaseSyncT | null) {}

  private requireDb(): DatabaseSyncT {
    if (!this.db) {
      throw new Error('nanites: no database handle available');
    }
    return this.db;
  }

  private withTransaction<T>(fn: (db: DatabaseSyncT) => T): T {
    const db = this.requireDb();
    db.exec('BEGIN');
    try {
      const out = fn(db);
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Nanite config CRUD
  // -------------------------------------------------------------------------

  createNanite(input: CreateNaniteInput): Nanite {
    const slug = (input.slug ?? '').trim();
    if (!slug) {
      throw new Error('slug is required');
    }
    const instructions = (input.instructions ?? '').trim();
    if (!instructions) {
      throw new Error('instructions are required');
    }
    const acceptanceCriteria = (input.acceptance_criteria ?? '').trim();
    if (!acceptanceCriteria) {
      throw new Error('acceptance_criteria is required');
    }
    const acceptanceThreshold =
      input.acceptance_threshold === undefined ? 60 : input.acceptance_threshold;
    const title = input.title?.trim() || slug;
    const kind = input.kind?.trim() || 'nanite';
    const triggerPhrase = input.trigger_phrase?.trim() ?? '';
    const model = input.model?.trim() ? input.model.trim() : null;
    const allowlist = JSON.stringify(input.tool_allowlist ?? []);
    const inputSchema = input.input_schema ?? null;
    const outputSchema = input.output_schema ?? null;
    const enabled = input.enabled === false ? 0 : 1;

    return this.withTransaction((db) => {
      const dup = db
        .prepare(`SELECT 1 AS x FROM nanites WHERE slug = ?`)
        .get(slug) as unknown as { x: number } | undefined;
      if (dup) {
        throw new Error(`nanite already exists: ${slug}`);
      }
      const now = nowEpoch();
      const info = db
        .prepare(
          `INSERT INTO nanites
             (slug, title, kind, trigger_phrase, instructions, model,
              tool_allowlist, input_schema, output_schema, enabled,
              acceptance_criteria, acceptance_threshold,
              created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          slug,
          title,
          kind,
          triggerPhrase,
          instructions,
          model,
          allowlist,
          inputSchema,
          outputSchema,
          enabled,
          acceptanceCriteria,
          acceptanceThreshold,
          now,
          now,
        );
      const row = db
        .prepare(`SELECT ${NANITE_COLS} FROM nanites WHERE id = ?`)
        .get(Number(info.lastInsertRowid)) as unknown as NaniteRow;
      return hydrateNanite(row);
    });
  }

  listNanites(input: ListNanitesInput = {}): Nanite[] {
    if (!this.db) {
      return [];
    }
    const clauses: string[] = [];
    if (!input.include_deleted) {
      clauses.push('deleted_at IS NULL');
    }
    if (!input.include_disabled) {
      clauses.push('enabled = 1');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT ${NANITE_COLS} FROM nanites ${where} ORDER BY slug ASC`)
      .all() as unknown as NaniteRow[];
    return rows.map(hydrateNanite);
  }

  getNaniteBySlug(slug: string, includeDeleted = false): Nanite | null {
    if (!this.db) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT ${NANITE_COLS} FROM nanites WHERE slug = ?${
          includeDeleted ? '' : ' AND deleted_at IS NULL'
        }`,
      )
      .get(slug) as unknown as NaniteRow | undefined;
    return row ? hydrateNanite(row) : null;
  }

  getNaniteById(id: number, includeDeleted = false): Nanite | null {
    if (!this.db) {
      return null;
    }
    const row = this.db
      .prepare(
        `SELECT ${NANITE_COLS} FROM nanites WHERE id = ?${
          includeDeleted ? '' : ' AND deleted_at IS NULL'
        }`,
      )
      .get(id) as unknown as NaniteRow | undefined;
    return row ? hydrateNanite(row) : null;
  }

  /**
   * Partial-update a nanite's config by slug (mirrors `JournalStore.updateTopic`).
   * Only the provided fields are patched; any change bumps `updated_at`. Throws
   * when the nanite does not exist.
   */
  updateNanite(slug: string, patch: UpdateNaniteInput): Nanite {
    return this.withTransaction((db) => {
      const current = this.getNaniteBySlug(slug);
      if (!current) {
        throw new Error(`nanite not found: ${slug}`);
      }
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.title !== undefined) {
        sets.push('title = ?');
        params.push(patch.title.trim() || current.slug);
      }
      if (patch.kind !== undefined) {
        sets.push('kind = ?');
        params.push(patch.kind.trim() || 'nanite');
      }
      if (patch.trigger_phrase !== undefined) {
        sets.push('trigger_phrase = ?');
        params.push(patch.trigger_phrase.trim());
      }
      if (patch.instructions !== undefined) {
        const instructions = patch.instructions.trim();
        if (!instructions) {
          throw new Error('instructions must not be empty');
        }
        sets.push('instructions = ?');
        params.push(instructions);
      }
      if (patch.model !== undefined) {
        sets.push('model = ?');
        params.push(patch.model && patch.model.trim() ? patch.model.trim() : null);
      }
      if (patch.tool_allowlist !== undefined) {
        sets.push('tool_allowlist = ?');
        params.push(JSON.stringify(patch.tool_allowlist ?? []));
      }
      if (patch.input_schema !== undefined) {
        sets.push('input_schema = ?');
        params.push(patch.input_schema ?? null);
      }
      if (patch.output_schema !== undefined) {
        sets.push('output_schema = ?');
        params.push(patch.output_schema ?? null);
      }
      if (patch.enabled !== undefined) {
        sets.push('enabled = ?');
        params.push(patch.enabled ? 1 : 0);
      }
      if (patch.acceptance_criteria !== undefined) {
        const criteria = patch.acceptance_criteria.trim();
        if (!criteria) {
          throw new Error('acceptance_criteria must not be empty');
        }
        sets.push('acceptance_criteria = ?');
        params.push(criteria);
      }
      if (patch.acceptance_threshold !== undefined) {
        sets.push('acceptance_threshold = ?');
        params.push(patch.acceptance_threshold);
      }
      if (!sets.length) {
        return current;
      }
      sets.push('updated_at = ?');
      params.push(nowEpoch());
      params.push(slug);
      db.prepare(
        `UPDATE nanites SET ${sets.join(', ')} WHERE slug = ?`,
      ).run(...params);
      const row = db
        .prepare(`SELECT ${NANITE_COLS} FROM nanites WHERE slug = ?`)
        .get(slug) as unknown as NaniteRow;
      return hydrateNanite(row);
    });
  }

  /**
   * Soft-delete a nanite by slug (mirrors `JournalStore.softDeleteTopic` /
   * `restoreTopic` idempotency). Sets `deleted_at = now` where the slug matches
   * and the row is still live. Idempotent: a no-op returning `{ nanites: 0 }`
   * when the nanite is already soft-deleted, and throws only when the slug does
   * not exist at all. Transactioned via `withTransaction`.
   */
  deleteNanite(slug: string): SoftDeleteNaniteResult {
    const nanite = this.getNaniteBySlug(slug, true);
    if (!nanite) {
      throw new Error(`nanite not found: ${slug}`);
    }
    if (nanite.deleted_at !== null) {
      return { nanites: 0 };
    }
    return this.withTransaction((db) => {
      const res = db
        .prepare(
          `UPDATE nanites SET deleted_at = ?
            WHERE slug = ? AND deleted_at IS NULL`,
        )
        .run(nowEpoch(), slug);
      return { nanites: Number(res.changes) };
    });
  }

  /**
   * Restore a soft-deleted nanite by slug (mirrors `JournalStore.restoreTopic`).
   * Clears `deleted_at` where the slug matches and the row is currently
   * soft-deleted. Idempotent: a no-op returning `{ nanites: 0 }` when the nanite
   * is already live, and throws only when the slug does not exist at all.
   */
  restoreNanite(slug: string): RestoreNaniteResult {
    const nanite = this.getNaniteBySlug(slug, true);
    if (!nanite) {
      throw new Error(`nanite not found: ${slug}`);
    }
    if (nanite.deleted_at === null) {
      return { nanites: 0 };
    }
    return this.withTransaction((db) => {
      const res = db
        .prepare(
          `UPDATE nanites SET deleted_at = NULL
            WHERE slug = ? AND deleted_at IS NOT NULL`,
        )
        .run(slug);
      return { nanites: Number(res.changes) };
    });
  }

  // -------------------------------------------------------------------------
  // Run audit trail
  // -------------------------------------------------------------------------

  /** Insert a run row in 'running' state and return its id. */
  startRun(naniteId: number): number {
    return this.withTransaction((db) => {
      const now = nowEpoch();
      const info = db
        .prepare(
          `INSERT INTO nanite_runs (nanite_id, status, started_at, created_at)
             VALUES (?, 'running', ?, ?)`,
        )
        .run(naniteId, now, now);
      return Number(info.lastInsertRowid);
    });
  }

  /** Finalize a run row with a terminal status + optional result / error. */
  finishRun(
    runId: number,
    status: 'succeeded' | 'failed',
    result: unknown,
    error: string | null,
  ): NaniteRun {
    return this.withTransaction((db) => {
      db.prepare(
        `UPDATE nanite_runs
            SET status = ?, ended_at = ?, result = ?, error = ?
          WHERE id = ?`,
      ).run(
        status,
        nowEpoch(),
        result === undefined || result === null ? null : JSON.stringify(result),
        error,
        runId,
      );
      const row = db
        .prepare(`SELECT ${RUN_COLS} FROM nanite_runs WHERE id = ?`)
        .get(runId) as unknown as NaniteRunRow;
      return hydrateRun(row);
    });
  }

  getRun(id: number): NaniteRun | null {
    if (!this.db) {
      return null;
    }
    const row = this.db
      .prepare(`SELECT ${RUN_COLS} FROM nanite_runs WHERE id = ?`)
      .get(id) as unknown as NaniteRunRow | undefined;
    return row ? hydrateRun(row) : null;
  }

  listRuns(naniteId: number, limit = 20): NaniteRun[] {
    if (!this.db) {
      return [];
    }
    const rows = this.db
      .prepare(
        `SELECT ${RUN_COLS} FROM nanite_runs
          WHERE nanite_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(naniteId, limit) as unknown as NaniteRunRow[];
    return rows.map(hydrateRun);
  }
}
