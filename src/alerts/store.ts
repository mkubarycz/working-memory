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
        `SELECT id, description, recommended_action, status, dedupe_key,
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
    const recommendedAction = input.recommended_action ?? '';
    const topicSlugs = Array.from(new Set(input.topic_slugs ?? []));

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
             (description, recommended_action, status, dedupe_key,
              created_by, created_at, updated_at)
           VALUES (?, ?, 'alert', ?, ?, ?, ?)`,
        )
        .run(description, recommendedAction, dedupeKey, createdBy, now, now);
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
        `SELECT a.id, a.description, a.recommended_action, a.status,
                a.dedupe_key, a.created_by, a.created_at, a.updated_at
           FROM alerts a
           ${where}
           ORDER BY ${STATUS_ORDER_SQL.replace(/status/g, 'a.status')},
                    a.created_at DESC, a.id DESC`,
      )
      .all(...params) as unknown as Alert[];
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
