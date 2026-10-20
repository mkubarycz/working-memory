/**
 * Pure alert-callout shaping for the document editor's workstream + topic views
 * (WM 14.2 alerts-on-document-views). NO VS Code, no client, no DB — just the
 * scope / dim / sort logic — so it is unit-tested directly and stays out of the
 * vscode import graph (mirrors `refreshDecision.ts`).
 */

import type { Alert } from '../controlPlaneClient';

export interface AlertVM {
  id: string;
  title: string;
  description: string;
  recommendedAction: string;
  status: 'alert' | 'informational' | 'closed';
  updatedAt: number;
  dimmed: boolean;
}

/** Sort rank so active alerts float above informational. */
function alertStatusRank(status: string): number {
  return status === 'alert' ? 0 : 1;
}

function scopedAlerts(alerts: Alert[], scopeSlugs: readonly string[]): Alert[] {
  const scope = new Set(scopeSlugs);
  return alerts.filter((a) => a.topics.some((t) => scope.has(t)));
}

function toAlertVM(a: Alert): AlertVM {
  return {
    id: a.id,
    title: a.title.trim() || a.description.split('\n')[0] || 'Alert',
    description: a.description,
    recommendedAction: a.recommended_action,
    status: a.status,
    updatedAt: a.updated_at,
    dimmed: a.status === 'closed',
  };
}

/**
 * Shape the scoped, ordered OPEN alert callouts for a workstream / topic view.
 * Pure (no client, no VS Code APIs) so it is unit-tested directly.
 *
 * Scope: an alert is relevant when its `topics` intersect `scopeSlugs` (a single
 * topic slug for the topic view; the member-topic slugs for the workstream
 * view). Closed alerts are excluded here and surfaced by
 * {@link buildAlertHistoryVMs} instead. Ordered active → informational,
 * newest-first within each tier, then by id for a stable order.
 */
export function buildAlertVMs(alerts: Alert[], scopeSlugs: readonly string[]): AlertVM[] {
  return scopedAlerts(alerts, scopeSlugs)
    .filter((a) => a.status !== 'closed')
    .sort((a, b) => {
      const rank = alertStatusRank(a.status) - alertStatusRank(b.status);
      if (rank !== 0) return rank;
      return b.updated_at - a.updated_at || a.id.localeCompare(b.id);
    })
    .map(toAlertVM);
}

/**
 * Shape the scoped CLOSED (dismissed) alerts for the alert-history log at the
 * bottom of a workstream / topic view. Every closed alert in scope is kept — no
 * recency cutoff — so older dismissals stay reachable and reopenable. Ordered
 * most-recently-updated (i.e. most recently closed) first, then by id.
 */
export function buildAlertHistoryVMs(
  alerts: Alert[],
  scopeSlugs: readonly string[],
): AlertVM[] {
  return scopedAlerts(alerts, scopeSlugs)
    .filter((a) => a.status === 'closed')
    .sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id))
    .map(toAlertVM);
}

export interface AlertBubble {
  count: number;
  severity: 'alert' | 'informational' | null;
}

/**
 * Open-alert bubble for a single topic slug: counts the OPEN alerts
 * (`status !== 'closed'`) whose `topics` include `slug`; severity is the max
 * (`alert` > `informational`, else null). Same semantics as the rail's per-topic
 * badge, reused for the workstream tree + family-tree alert counts.
 */
export function alertBubbleForTopic(alerts: Alert[], slug: string): AlertBubble {
  let count = 0;
  let hasAlert = false;
  let hasInfo = false;
  for (const a of alerts) {
    if (a.status === 'closed' || !a.topics.includes(slug)) {
      continue;
    }
    count += 1;
    if (a.status === 'alert') {
      hasAlert = true;
    } else if (a.status === 'informational') {
      hasInfo = true;
    }
  }
  return { count, severity: hasAlert ? 'alert' : hasInfo ? 'informational' : null };
}
