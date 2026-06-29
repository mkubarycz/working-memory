/**
 * Type shapes for the alerts feature. Kept separate from `src/db.ts` so the
 * whole feature lives under `src/alerts/` and can be reasoned about (and
 * toggled) in one place.
 */

export type AlertStatus = 'alert' | 'informational' | 'closed';

/** The three statuses that keep an alert in the active queue / index. */
export const OPEN_ALERT_STATUSES: readonly AlertStatus[] = ['alert', 'informational'];

export interface Alert {
  id: number;
  /** Friendly, short, editable label. Derived from description when blank. */
  title: string;
  description: string;
  recommended_action: string;
  status: AlertStatus;
  /**
   * Always populated. Caller-supplied when given, otherwise derived from
   * `hash(created_by + description + sorted topic_slugs)`. The unique partial
   * index `idx_alerts_dedupe_open` enforces one OPEN alert per key.
   */
  dedupe_key: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** An alert plus the slugs of the topics it flags. */
export interface AlertWithTopics extends Alert {
  topics: string[];
}

export interface CreateAlertInput {
  description: string;
  /** Optional friendly title; defaults to first ~60 chars of description. */
  title?: string;
  recommended_action?: string;
  /** The M:N targets. Must already exist (no stub creation). */
  topic_slugs?: string[];
  created_by?: string;
  /** Caller-supplied dedupe key. Derived if omitted. */
  dedupe_key?: string;
}

export interface CreateAlertResult {
  alert: AlertWithTopics;
  /** true when an existing open alert was upserted rather than a row inserted. */
  deduped: boolean;
}

export interface ListAlertsInput {
  /**
   * Filter by status. Defaults to the active queue (`alert` + `informational`).
   * Pass `'all'` to include closed.
   */
  status?: AlertStatus | 'active' | 'all';
  /** Scope to alerts linked to this topic. */
  topic_slug?: string;
}

export interface UpdateAlertInput {
  title?: string;
  description?: string;
  recommended_action?: string;
  status?: AlertStatus;
}

export interface AlertTopicLinkResult {
  alert_id: number;
  topic_slug: string;
  /** false when the link already existed (idempotent). */
  link_created: boolean;
}

export interface AlertTopicUnlinkResult {
  alert_id: number;
  topic_slug: string;
  /** false when there was nothing to remove. */
  unlinked: boolean;
}
