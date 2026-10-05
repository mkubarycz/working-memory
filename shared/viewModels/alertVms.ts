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

/**
 * Window (ms) a CLOSED alert stays visible after its last update so its Reopen
 * actions remain reachable; older closed alerts are hidden entirely. Mirrors
 * the retired journal renderer's 1-hour `topicAlertsWithRecentClosed` cutoff.
 */
export const RECENT_CLOSED_ALERT_MS = 60 * 60 * 1000;

/** Sort rank so active alerts float above informational above closed. */
function alertStatusRank(status: string): number {
  if (status === 'alert') {
    return 0;
  }
  if (status === 'informational') {
    return 1;
  }
  return 2;
}

/**
 * Shape the scoped, ordered alert callouts for a workstream / topic view. Pure
 * (no client, no VS Code APIs) so it is unit-tested directly.
 *
 * Scope: an alert is relevant when its `topics` intersect `scopeSlugs` (a single
 * topic slug for the topic view; the member-topic slugs for the workstream
 * view). A CLOSED alert is kept only when it was updated within
 * {@link RECENT_CLOSED_ALERT_MS} of `now` (surfaced dimmed, still reopenable);
 * older closed alerts drop out. Ordered active → informational → recent-closed,
 * newest-first within each tier.
 */
export function buildAlertVMs(
  alerts: Alert[],
  scopeSlugs: readonly string[],
  now: number,
): AlertVM[] {
  const scope = new Set(scopeSlugs);
  return alerts
    .filter((a) => a.topics.some((t) => scope.has(t)))
    .filter(
      (a) => a.status !== 'closed' || now - a.updated_at <= RECENT_CLOSED_ALERT_MS,
    )
    .sort((a, b) => {
      const rank = alertStatusRank(a.status) - alertStatusRank(b.status);
      return rank !== 0 ? rank : b.updated_at - a.updated_at;
    })
    .map((a) => ({
      id: a.id,
      title: a.title.trim() || a.description.split('\n')[0] || 'Alert',
      description: a.description,
      recommendedAction: a.recommended_action,
      status: a.status,
      updatedAt: a.updated_at,
      dimmed: a.status === 'closed',
    }));
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
