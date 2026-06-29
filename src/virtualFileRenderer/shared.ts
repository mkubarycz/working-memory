import { type Topic, type TopicStatus } from '../db';
import { JournalStore } from '../db';

const TZ = 'America/New_York';

export const EDITABLE_DIV_OPEN =
  '<div style="border-left: 5px solid green; padding-left: 15px;">';
export const EDITABLE_DIV_CLOSE = '</div>';
export const EDITABLE_COMMENT_START = '<!-- editable -->';
export const EDITABLE_COMMENT_END = '<!-- /editable -->';
export const EDITABLE_LABEL_COMMENT_START = '<!-- editable:label -->';
export const EDITABLE_LABEL_COMMENT_END = '<!-- /editable:label -->';
export const EDITABLE_DESCRIPTION_COMMENT_START = '<!-- editable:description -->';
export const EDITABLE_DESCRIPTION_COMMENT_END = '<!-- /editable:description -->';
export const EDITABLE_STATUS_COMMENT_START = '<!-- editable:status -->';
export const EDITABLE_STATUS_COMMENT_END = '<!-- /editable:status -->';
export const EDITABLE_ACTION_COMMENT_START = '<!-- editable:action -->';
export const EDITABLE_ACTION_COMMENT_END = '<!-- /editable:action -->';
export const DESCRIPTION_EMPTY_PLACEHOLDER = '—';

export function deepLink(
  kind: 'topic' | 'session' | 'workstream' | 'topic-type' | 'alert',
  id: string,
): string {
  return `vscode://kubarycz.working-memory/open/${kind}/${encodeURIComponent(id)}`;
}

/**
 * Deep link to mutate an alert via the extension URI handler. Routed as
 * `vscode://kubarycz.working-memory/alert/<id>/<action>`. Used by the alert
 * cards' Acknowledge / Close pills because `command:` links are stripped by the
 * built-in markdown preview.
 */
export function alertActionLink(
  id: number,
  action: 'acknowledge' | 'close' | 'reopen',
): string {
  return `vscode://kubarycz.working-memory/alert/${id}/${action}`;
}

export function fmtDateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) {
    return '—';
  }
  const d = new Date(unixSeconds * 1000);
  const date = d.toLocaleDateString('en-CA', { timeZone: TZ });
  const time = d.toLocaleTimeString('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${date} ${time}`;
}

/** Friendly relative time, e.g. "just now", "25 minutes ago", "1 day ago". */
export function fmtRelative(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) {
    return '—';
  }
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 0) {
    return 'just now';
  }
  const units: [number, string][] = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [secs, label] of units) {
    const n = Math.floor(diff / secs);
    if (n >= 1) {
      return `${n} ${label}${n === 1 ? '' : 's'} ago`;
    }
  }
  return 'just now';
}

export function fmtDuration(
  startedAt: number | null | undefined,
  endedAt: number | null | undefined,
): string | null {
  if (!startedAt || !endedAt || endedAt < startedAt) {
    return null;
  }
  const totalSec = endedAt - startedAt;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (h > 0) {
    parts.push(`${h}h`);
  }
  if (m > 0 || h > 0) {
    parts.push(`${m}m`);
  }
  parts.push(`${s}s`);
  return parts.join(' ');
}

type BreadcrumbNode = { slug: string; title: string; status: TopicStatus };

function fmtBreadcrumbNode(node: BreadcrumbNode): string {
  const link = deepLink('topic', node.slug);
  if (node.status === 'closed') {
    return `~~[${node.title}](${link})~~`;
  }
  return `[${node.title}](${link})`;
}

/**
 * Build the breadcrumb family trail for a topic virtual doc.
 *
 * Walks up the first-parent chain to collect ancestors, then down the
 * first-child chain to collect descendants.  Returns `'Orphan'` when the
 * topic has no family.  A visited set guards against cycles in the DAG.
 */
export function buildTopicBreadcrumb(
  store: JournalStore,
  slug: string,
): string {
  const current = store.getTopic(slug);
  if (!current) {
    return 'Orphan';
  }

  // ── Ancestor walk (up via first parent at each level) ───────────────────
  const ancestors: BreadcrumbNode[] = [];
  let cursor = slug;
  const visitedUp = new Set<string>([slug]);
  while (true) {
    const parents = store.listTopicParents(cursor);
    if (parents.length === 0) {
      break;
    }
    const parent = parents[0];
    if (visitedUp.has(parent.slug)) {
      break; // cycle guard
    }
    visitedUp.add(parent.slug);
    ancestors.unshift({ slug: parent.slug, title: parent.title, status: parent.status });
    cursor = parent.slug;
  }

  // ── Descendant walk (down via first child at each level) ─────────────────
  const descendants: BreadcrumbNode[] = [];
  cursor = slug;
  const visitedDown = new Set<string>([slug]);
  while (true) {
    const children = store.listTopicChildren(cursor);
    if (children.length === 0) {
      break;
    }
    const child = children[0];
    if (visitedDown.has(child.slug)) {
      break; // cycle guard
    }
    visitedDown.add(child.slug);
    descendants.push({ slug: child.slug, title: child.title, status: child.status });
    cursor = child.slug;
  }

  if (ancestors.length === 0 && descendants.length === 0) {
    return 'Orphan';
  }

  const currentLabel = `**${current.title}**`;

  const parts = [
    ...ancestors.map(fmtBreadcrumbNode),
    currentLabel,
    ...descendants.map(fmtBreadcrumbNode),
  ];

  return parts.join(' > ');
}

export function topicPill(t: Topic): string {
  return `[${t.title}](${deepLink('topic', t.slug)})`;
}
