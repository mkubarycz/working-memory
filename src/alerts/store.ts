import { createHash } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';
import {
  type Alert,
  type AlertStatus,
  type AlertTopicLinkResult,
  type AlertTopicUnlinkResult,
  type AlertWithTopics,
  type CreateAlertInput,
  type CreateAlertResult,
  type ListAlertsInput,
  type UpdateAlertInput,
} from './types';

function nowEpoch(): number {
  return Math.floor(Date.now() / 1000);
}

/** First ~60 chars of the (single-line) description, used when no title given. */
function defaultTitleFrom(description: string): string {
  const firstLine = description.trim().split('\n')[0].trim();
  return firstLine.length > 60 ? firstLine.slice(0, 60) : firstLine;
}

/**
 * Single on/off switch for the entire alerts feature. Flip to `false` and the
 * whole feature — every `wm_*alert*` tool — stops registering. (The migration
 * and the static `package.json` tool declarations are inert manifest data and
 * stay put; nothing wires up at runtime when this is off.)
 */
export const ALERTS_ENABLED = true;

/** Severity order for the active queue: alert first, then informational, then closed. */
const STATUS_ORDER_SQL = `CASE status
    WHEN 'alert' THEN 0
    WHEN 'informational' THEN 1
    ELSE 2
  END`;

/**
 * Self-contained data layer for the alerts feature. Wraps a raw `node:sqlite`
 * handle (obtained via `JournalStore.connection`) rather than extending
 * `JournalStore`, so the whole feature stays under `src/alerts/`.
 *
 * Defensive contract (mirrors the rest of the codebase): read paths return
 * `[]` / `null` when the DB handle is missing and never throw; write paths
 * throw a clear error.
 */
export class AlertsStore {
  constructor(private readonly db: DatabaseSyncT | null) {}

  private requireDb(): DatabaseSyncT {
    if (!this.db) {
      throw new Error('alerts: no database handle available');
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
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Throw unless every slug names a live (non-soft-deleted) topic. */
  private assertTopicsExist(db: DatabaseSyncT, slugs: string[]): void {
    for (const slug of slugs) {
      const row = db
        .prepare(
          `SELECT slug FROM topics WHERE slug = ? AND deleted_at IS NULL`,
        )
        .get(slug) as unknown as { slug: string } | undefined;
      if (!row) {
        throw new Error(`topic not found (or soft-deleted): ${slug}`);
      }
    }
  }

  private topicsForAlert(db: DatabaseSyncT, alertId: number): string[] {
    const rows = db
      .prepare(
        `SELECT topic_slug FROM alert_topics WHERE alert_id = ? ORDER BY topic_slug ASC`,
      )
      .all(alertId) as unknown as { topic_slug: string }[];
    return rows.map((r) => r.topic_slug);
  }

  private alertRow(db: DatabaseSyncT, id: number): Alert | null {
    const row = db
      .prepare(
        `SELECT id, title, description, recommended_action, status, dedupe_key,
                created_by, created_at, updated_at
           FROM alerts WHERE id = ?`,
      )
      .get(id) as unknown as Alert | undefined;
    return row ?? null;
  }

  private withTopics(db: DatabaseSyncT, alert: Alert): AlertWithTopics {
    return { ...alert, topics: this.topicsForAlert(db, alert.id) };
  }

  /**
   * Derived dedupe key: `hash(created_by + '\n' + description + '\n' +
   * sorted(topic_slugs).join(','))`. Because the topic set is part of the
   * hash, "10 alerts to 10 distinct topics" yields 10 distinct keys, while a
   * re-run of the same job + text + topics collides and upserts.
   */
  private deriveDedupeKey(
    createdBy: string,
    description: string,
    topicSlugs: string[],
  ): string {
    const sorted = [...topicSlugs].sort();
    const material = `${createdBy}\n${description}\n${sorted.join(',')}`;
    return createHash('sha256').update(material).digest('hex');
  }

  private ensureLink(db: DatabaseSyncT, alertId: number, slug: string, now: number): void {
    db.prepare(
      `INSERT OR IGNORE INTO alert_topics (alert_id, topic_slug, created_at)
         VALUES (?, ?, ?)`,
    ).run(alertId, slug, now);
  }

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  createAlert(input: CreateAlertInput): CreateAlertResult {
    const description = (input.description ?? '').trim();
    if (!description) {
      throw new Error('description is required');
    }
    const createdBy = input.created_by?.trim() || 'system';
    const title = input.title?.trim() || defaultTitleFrom(description);
    const recommendedAction = input.recommended_action ?? '';
    const topicSlugs = Array.from(new Set(input.topic_slugs ?? []));
    if (topicSlugs.length === 0) {
      throw new Error('at least one topic is required');
    }

    return this.withTransaction((db) => {
      this.assertTopicsExist(db, topicSlugs);

      const dedupeKey =
        input.dedupe_key?.trim() ||
        this.deriveDedupeKey(createdBy, description, topicSlugs);

      const now = nowEpoch();

      // Upsert: if an OPEN alert already holds this key, refresh it and
      // re-raise to 'alert' rather than inserting a duplicate.
      const open = db
        .prepare(
          `SELECT id FROM alerts WHERE dedupe_key = ? AND status != 'closed'`,
        )
        .get(dedupeKey) as unknown as { id: number } | undefined;

      if (open) {
        db.prepare(
          `UPDATE alerts
              SET description = ?, recommended_action = ?,
                  status = 'alert', updated_at = ?
            WHERE id = ?`,
        ).run(description, recommendedAction, now, open.id);
        for (const slug of topicSlugs) {
          this.ensureLink(db, open.id, slug, now);
        }
        const alert = this.alertRow(db, open.id)!;
        return { alert: this.withTopics(db, alert), deduped: true };
      }

      const info = db
        .prepare(
          `INSERT INTO alerts
             (title, description, recommended_action, status, dedupe_key,
              created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'alert', ?, ?, ?, ?)`,
        )
        .run(title, description, recommendedAction, dedupeKey, createdBy, now, now);
      const alertId = Number(info.lastInsertRowid);
      for (const slug of topicSlugs) {
        this.ensureLink(db, alertId, slug, now);
      }
      const alert = this.alertRow(db, alertId)!;
      return { alert: this.withTopics(db, alert), deduped: false };
    });
  }

  getAlert(id: number): AlertWithTopics | null {
    if (!this.db) {
      return null;
    }
    const alert = this.alertRow(this.db, id);
    if (!alert) {
      return null;
    }
    return this.withTopics(this.db, alert);
  }

  listAlerts(input: ListAlertsInput = {}): AlertWithTopics[] {
    if (!this.db) {
      return [];
    }
    const status = input.status ?? 'active';
    const clauses: string[] = [];
    const params: (string | number)[] = [];

    if (status === 'active') {
      clauses.push("a.status != 'closed'");
    } else if (status !== 'all') {
      clauses.push('a.status = ?');
      params.push(status);
    }

    if (input.topic_slug) {
      clauses.push(
        'a.id IN (SELECT alert_id FROM alert_topics WHERE topic_slug = ?)',
      );
      params.push(input.topic_slug);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT a.id, a.title, a.description, a.recommended_action, a.status,
                a.dedupe_key, a.created_by, a.created_at, a.updated_at
           FROM alerts a
           ${where}
           ORDER BY ${STATUS_ORDER_SQL.replace(/status/g, 'a.status')},
                    a.created_at DESC, a.id DESC`,
      )
      .all(...params) as unknown as Alert[];
    return rows.map((a) => this.withTopics(this.db!, a));
  }

  /**
   * Per-topic rollup for the panel bubble (A/C): how many OPEN alerts
   * (`alert` + `informational`) flag this topic, and the highest severity
   * among them. `severity` is `'alert'` if any open alert is loud, else
   * `'informational'` if there are quiet ones, else `null` (zero open).
   */
  openCountForTopic(slug: string): { count: number; severity: 'alert' | 'informational' | null } {
    if (!this.db) {
      return { count: 0, severity: null };
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n,
                SUM(CASE WHEN a.status = 'alert' THEN 1 ELSE 0 END) AS loud
           FROM alerts a
           JOIN alert_topics t ON t.alert_id = a.id
          WHERE t.topic_slug = ? AND a.status != 'closed'`,
      )
      .get(slug) as unknown as { n: number; loud: number } | undefined;
    const count = Number(row?.n ?? 0);
    if (count === 0) {
      return { count: 0, severity: null };
    }
    return { count, severity: Number(row?.loud ?? 0) > 0 ? 'alert' : 'informational' };
  }

  /**
   * Per-workstream rollup for the workstream-card / shelf bubble: how many
   * DISTINCT open alerts (`alert` + `informational`) flag any topic linked to
   * the workstream, and the highest severity among them. Mirrors
   * `openCountForTopic` but aggregates across the workstream's linked topics
   * (deduping alerts shared by multiple topics). `severity` is `'alert'` if any
   * open alert is loud, else `'informational'` if there are quiet ones, else
   * `null` (zero open).
   */
  openCountForWorkstream(
    workstreamId: number,
  ): { count: number; severity: 'alert' | 'informational' | null } {
    if (!this.db) {
      return { count: 0, severity: null };
    }
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT a.id) AS n,
                SUM(CASE WHEN a.status = 'alert' THEN 1 ELSE 0 END) AS loud
           FROM alerts a
           JOIN alert_topics at ON at.alert_id = a.id
           JOIN workstream_topics wt ON wt.topic_slug = at.topic_slug
          WHERE wt.workstream_id = ?
            AND wt.deleted_at IS NULL
            AND a.status != 'closed'`,
      )
      .get(workstreamId) as unknown as { n: number; loud: number } | undefined;
    const count = Number(row?.n ?? 0);
    if (count === 0) {
      return { count: 0, severity: null };
    }
    return { count, severity: Number(row?.loud ?? 0) > 0 ? 'alert' : 'informational' };
  }

  /**
   * Alerts to show on a topic page (B): all active alerts plus any `closed`
   * alert whose `updated_at` is within `withinSeconds` of now (default 1h) so
   * a just-resolved alert lingers briefly. Ordered alert → informational →
   * (recent) closed, newest first within a band.
   */
  topicAlertsWithRecentClosed(
    slug: string,
    withinSeconds = 3600,
  ): AlertWithTopics[] {
    if (!this.db) {
      return [];
    }
    const cutoff = nowEpoch() - withinSeconds;
    const rows = this.db
      .prepare(
        `SELECT a.id, a.title, a.description, a.recommended_action, a.status,
                a.dedupe_key, a.created_by, a.created_at, a.updated_at
           FROM alerts a
           JOIN alert_topics t ON t.alert_id = a.id
          WHERE t.topic_slug = ?
            AND (a.status != 'closed' OR a.updated_at >= ?)
          ORDER BY ${STATUS_ORDER_SQL.replace(/status/g, 'a.status')},
                   a.updated_at DESC, a.id DESC`,
      )
      .all(slug, cutoff) as unknown as Alert[];
    return rows.map((a) => this.withTopics(this.db!, a));
  }

  updateAlert(id: number, input: UpdateAlertInput): AlertWithTopics {
    return this.withTransaction((db) => {
      const current = this.alertRow(db, id);
      if (!current) {
        throw new Error(`alert not found: ${id}`);
      }

      const sets: string[] = [];
      const params: (string | number)[] = [];

      if (input.title !== undefined) {
        sets.push('title = ?');
        params.push(input.title.trim());
      }
      if (input.description !== undefined) {
        const desc = input.description.trim();
        if (!desc) {
          throw new Error('description cannot be empty');
        }
        sets.push('description = ?');
        params.push(desc);
      }
      if (input.recommended_action !== undefined) {
        sets.push('recommended_action = ?');
        params.push(input.recommended_action);
      }
      if (input.status !== undefined) {
        const valid: AlertStatus[] = ['alert', 'informational', 'closed'];
        if (!valid.includes(input.status)) {
          throw new Error(
            `invalid status '${String(input.status)}' — must be one of ${valid.join(', ')}`,
          );
        }
        sets.push('status = ?');
        params.push(input.status);
      }

      if (sets.length === 0) {
        // No-op edit still returns the current row (no updated_at churn).
        return this.withTopics(db, current);
      }

      sets.push('updated_at = ?');
      params.push(nowEpoch());
      params.push(id);

      db.prepare(`UPDATE alerts SET ${sets.join(', ')} WHERE id = ?`).run(
        ...params,
      );
      const updated = this.alertRow(db, id)!;
      return this.withTopics(db, updated);
    });
  }

  linkAlertTopic(alertId: number, topicSlug: string): AlertTopicLinkResult {
    return this.withTransaction((db) => {
      const alert = this.alertRow(db, alertId);
      if (!alert) {
        throw new Error(`alert not found: ${alertId}`);
      }
      this.assertTopicsExist(db, [topicSlug]);
      const existing = db
        .prepare(
          `SELECT 1 AS x FROM alert_topics WHERE alert_id = ? AND topic_slug = ?`,
        )
        .get(alertId, topicSlug) as unknown as { x: number } | undefined;
      if (existing) {
        return { alert_id: alertId, topic_slug: topicSlug, link_created: false };
      }
      db.prepare(
        `INSERT INTO alert_topics (alert_id, topic_slug, created_at)
           VALUES (?, ?, ?)`,
      ).run(alertId, topicSlug, nowEpoch());
      return { alert_id: alertId, topic_slug: topicSlug, link_created: true };
    });
  }

  unlinkAlertTopic(alertId: number, topicSlug: string): AlertTopicUnlinkResult {
    return this.withTransaction((db) => {
      const alert = this.alertRow(db, alertId);
      if (!alert) {
        throw new Error(`alert not found: ${alertId}`);
      }
      const info = db
        .prepare(
          `DELETE FROM alert_topics WHERE alert_id = ? AND topic_slug = ?`,
        )
        .run(alertId, topicSlug);
      return {
        alert_id: alertId,
        topic_slug: topicSlug,
        unlinked: Number(info.changes) > 0,
      };
    });
  }
}
