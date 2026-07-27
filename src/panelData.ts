import {
  JournalStore,
  type Session,
  type Topic,
  type TopicType,
  type TopicWithCounts,
  type WorkstreamSection,
  type WorkstreamTopicRow,
  type WorkstreamWithCount,
} from './db';
import { TRAVERSAL_MODES } from './graphTraversals';
import { AlertsStore, ALERTS_ENABLED } from './alerts/store';
import type { AlertStatus } from './alerts/types';
import { NanitesStore, NANITES_ENABLED } from './nanites/store';
import type {
  DocumentEnvelope,
  ListDocumentsResult,
  Workstream,
  Topic as ControlPlaneTopic,
} from './controlPlaneClient';

/**
 * Plain-JSON shapes shipped to the webview. Keep these serializable —
 * nothing in here may reference `vscode.*` types or DB row objects directly.
 */
export type PanelTab =
  | 'active'
  | 'archive'
  | 'topics'
  | 'topic-types'
  | 'alerts'
  | 'nanites'
  | 'blackboard';

export interface PanelAction {
  /** VS Code command id to invoke. */
  command: string;
  /** Human-readable label for the quick-pick / menu. */
  title: string;
  /** Optional secondary text shown in the quick-pick. */
  description?: string;
  /** Args to pass to the command. */
  args?: unknown[];
  /** Optional codicon id rendered beside the menu label (e.g. 'arrow-circle-up'). */
  icon?: string;
}

export interface PanelTopic {
  kind: 'topic';
  id: string;
  label: string;
  description: string;
  tooltip: string;
  /** Codicon id (e.g. 'rocket', 'checklist'). Sourced from topic_types.icon. */
  icon: string;
  openUri: string;
  status: 'open' | 'closed';
  recentEntryCount: number;
  actions?: PanelAction[];
  /**
   * Whether this topic is currently focused in the parent workstream
   * (workstream-focus-mechanism). Plumbed through for the UI to render a
   * marker; the panel doesn't render it yet (follow-up task).
   */
  focused: boolean;
  /** Open-alert count for the bubble (A); 0 hides it. */
  alertCount?: number;
  /** Max severity among open alerts: 'alert' reddish, 'informational' default (C). */
  alertSeverity?: 'alert' | 'informational' | null;
  /**
   * Nested child topics — populated when a workstream's linked topics have
   * parent/child relationships among themselves. Only set when non-empty.
   */
  children?: PanelTopic[];
}

export interface PanelTopicsGroup {
  kind: 'topics-group';
  id: string;
  label: string;
  description?: string;
  /** Codicon id for the group header. */
  icon: string;
  collapsible: boolean;
  children: PanelTopic[];
}

export interface PanelSession {
  kind: 'session';
  id: string;
  label: string;
  description: string;
  tooltip: string;
  /** Codicon id (default 'comment-discussion'). */
  icon: string;
  openUri: string;
  recentEntryCount: number;
}

export interface PanelSessionsGroup {
  kind: 'sessions-group';
  id: string;
  label: string;
  description?: string;
  icon: string;
  collapsible: boolean;
  children: PanelSession[];
}

export interface PanelWorkstream {
  kind: 'workstream';
  id: string;
  label: string;
  description: string;
  tooltip: string;
  openUri: string;
  recentEntryCount: number;
  /**
   * The Active-tab section this workstream currently lives in
   * (queue/progress/backlog). Plumbed to the webview so a drag-reorder can tag
   * the dragged row and target the correct section (cross-section drops
   * included). Only meaningful on the Active tab; omitted on Archive.
   */
  section?: WorkstreamSection;
  /**
   * Open-alert count aggregated across the workstream's linked topics; 0
   * hides the bubble. Replaces the entry-count chip on workstream rows.
   */
  alertCount?: number;
  /** Max severity among open alerts: 'alert' reddish, 'informational' default. */
  alertSeverity?: 'alert' | 'informational' | null;
  actions: PanelAction[];
  /**
   * Focused topics for this workstream, in linked_at order (newest first).
   * Subset of the topics rendered in the regular topics group below; the
   * panel renders these as a pinned quick-access row at the top of the
   * workstream card. Empty array when no topic is focused.
   */
  focused_topics: PanelTopic[];
  children: (PanelTopicsGroup | PanelSessionsGroup)[];
}

/**
 * One of the three vertically-stacked groups on the Active tab. `progress`
 * renders its workstreams as full cards (today's behavior); `queue` and
 * `backlog` render as a compact "peek shelf". The webview keys expand-state
 * off `id`. Display mode is derived from `section` but shipped explicitly so
 * the renderer doesn't have to branch on the section name.
 */
export interface PanelWorkstreamSection {
  kind: 'workstream-section';
  id: string;
  section: WorkstreamSection;
  label: string;
  display: 'cards' | 'shelf';
  workstreams: PanelWorkstream[];
  /** Shown when this section has no workstreams. */
  emptyMessage: string;
}

export interface PanelTopicRow {
  kind: 'topic-row';
  id: string;
  label: string;
  description: string;
  tooltip: string;
  /** Codicon id (per-topic, sourced from topic_types.icon). */
  icon: string;
  openUri: string;
  status: 'open' | 'closed';
  recentEntryCount: number;
  actions?: PanelAction[];
  alertCount?: number;
  alertSeverity?: 'alert' | 'informational' | null;
  children?: PanelTopicRow[];
}

export interface PanelTopicType {
  kind: 'topic-type';
  id: string;
  label: string;
  description: string;
  tooltip: string;
  icon: string;
  openUri: string;
  topicCount: number;
}

export interface PanelAlert {
  kind: 'alert';
  id: string;
  label: string;
  description: string;
  tooltip: string;
  icon?: string;
  openUri: string;
  status: AlertStatus;
  /** Topic slugs this alert is linked to. */
  topics: string[];
  actions?: PanelAction[];
}

export interface PanelNanite {
  kind: 'nanite';
  id: string;
  label: string;
  description: string;
  tooltip: string;
  icon: string;
  openUri: string;
  /** Whether the nanite is runnable. Muted in the UI when false. */
  enabled: boolean;
  /** Whether the nanite is soft-deleted. Muted + offers Restore when true. */
  deleted: boolean;
  actions?: PanelAction[];
}

/**
 * A Blackboard-tab row: one control-plane document envelope, sourced through
 * the MCP `wm-document-read` tool (not the journal DB). Mirrors the visual
 * shape of `PanelTopicRow` so the webview renders it with the same row path.
 */
export interface PanelDocumentRow {
  kind: 'document-row';
  id: string;
  label: string;
  description: string;
  tooltip: string;
  /** Codicon id. */
  icon: string;
  /** `working-memory:/document/<id>.md` virtual-doc URI. */
  openUri: string;
}

export type PanelItem =
  | PanelWorkstream
  | PanelWorkstreamSection
  | PanelTopicRow
  | PanelTopicType
  | PanelAlert
  | PanelNanite
  | PanelDocumentRow;

export interface PanelData {
  tab: PanelTab;
  items: PanelItem[];
  emptyMessage: string;
}

/** Fallback codicon id when a topic_type isn't in the type map. */
const FALLBACK_TOPIC_ICON = 'symbol-key';
/** Fallback codicon id for an empty (no topics linked) group header. */
const FALLBACK_GROUP_ICON = 'symbol-keyword';
/** Codicon id used for individual session rows. */
const SESSION_ROW_ICON = 'comment-discussion';
/** Codicon id used for the Sessions group header. */
const SESSIONS_GROUP_ICON = 'history';
const ALL_TIME_SINCE = 0;
function describeTopic(t: WorkstreamTopicRow): string {
  const here = t.entry_count_in_workstream;
  const elsewhere = t.entry_count - here;
  const parts: string[] = [];
  if (here > 0) {
    parts.push(`${here} entr${here === 1 ? 'y' : 'ies'} here`);
  }
  if (elsewhere > 0) {
    parts.push(`${elsewhere} elsewhere`);
  }
  if (t.status !== 'open') {
    parts.push(t.status);
  }
  return parts.join(' • ');
}

function describeTopicRow(t: TopicWithCounts): string {
  const parts: string[] = [];
  if (t.workstream_count > 0) {
    parts.push(
      `${t.workstream_count} workstream${t.workstream_count === 1 ? '' : 's'}`,
    );
  }
  if (t.entry_count > 0) {
    parts.push(
      `${t.entry_count} entr${t.entry_count === 1 ? 'y' : 'ies'}`,
    );
  }
  return parts.join(' • ');
}

function iconForType(
  typeId: string,
  typeMap: Map<string, TopicType>,
): string {
  return typeMap.get(typeId)?.icon ?? FALLBACK_TOPIC_ICON;
}

/** Open-alert bubble (count + max severity) for a topic, or null when off. */
function alertBubble(
  store: JournalStore,
  slug: string,
): { count: number; severity: 'alert' | 'informational' | null } | null {
  if (!ALERTS_ENABLED) {
    return null;
  }
  const roll = new AlertsStore(store.connection).openCountForTopic(slug);
  return roll.count > 0 ? roll : null;
}

/**
 * Open-alert bubble (count + max severity) aggregated across a workstream's
 * linked topics, or null when off / zero. Mirrors `alertBubble` but for a
 * whole workstream row.
 */
function workstreamAlertBubble(
  store: JournalStore,
  workstreamId: number,
): { count: number; severity: 'alert' | 'informational' | null } | null {
  if (!ALERTS_ENABLED) {
    return null;
  }
  const roll = new AlertsStore(store.connection).openCountForWorkstream(
    workstreamId,
  );
  return roll.count > 0 ? roll : null;
}

/** Per-alert context-menu actions for the Alerts tab / virtual doc. */
function alertActions(id: number, status: AlertStatus): PanelAction[] {
  const actions: PanelAction[] = [
    { command: 'working-memory.alert.editDescription', title: 'Edit description', args: [{ id }] },
    { command: 'working-memory.alert.editAction', title: 'Edit recommended action', args: [{ id }] },
  ];
  if (status !== 'alert') {
    actions.push({ command: 'working-memory.alert.setStatus', title: 'Raise to Alert', args: [{ id, status: 'alert' }], icon: 'arrow-circle-up' });
  }
  if (status !== 'informational') {
    actions.push({ command: 'working-memory.alert.setStatus', title: 'Mark Informational', args: [{ id, status: 'informational' }] });
  }
  if (status !== 'closed') {
    actions.push({ command: 'working-memory.alert.setStatus', title: 'Close', args: [{ id, status: 'closed' }], icon: 'check' });
  }
  return actions;
}

function traversalActionTitle(mode: (typeof TRAVERSAL_MODES)[keyof typeof TRAVERSAL_MODES]): string {
  switch (mode.id) {
    case 'self':
      return 'Add this topic';
    case 'immediateFamilyOf':
      return 'Add immediate family';
    case 'childrenOf':
      return 'Add children only';
    case 'recursiveFamilyOf':
      return 'Add family tree';
    default:
      return `Add ${mode.label}`;
  }
}

function topicActions(topicSlug: string, workstreamSlug?: string): PanelAction[] {
  const add = Object.values(TRAVERSAL_MODES).map((mode) => ({
    command: 'workingMemory.topic.addToWorkstream',
    title: traversalActionTitle(mode),
    description: mode.description,
    args: [{
      topicSlug,
      traversalId: mode.id,
      ...(workstreamSlug ? { workstreamSlug } : {}),
    }],
  }));
  return [
    ...add,
    {
      command: 'workingMemory.topic.removeFromWorkstream',
      title: 'Remove from workstream',
      args: [{
        topicSlug,
        ...(workstreamSlug ? { workstreamSlug } : {}),
      }],
    },
  ];
}

function buildTopics(
  store: JournalStore,
  tab: PanelTab,
  ws: WorkstreamWithCount,
  typeMap: Map<string, TopicType>,
): { group: PanelTopicsGroup; orderedTopics: PanelTopic[] } {
  const topics = store.listTopicsForWorkstream(ws.id);
  const panelBySlug = new Map<string, PanelTopic>();
  const ordered: PanelTopic[] = [];
  for (const t of topics) {
    const bubble = alertBubble(store, t.slug);
    const panel: PanelTopic = {
      kind: 'topic',
      id: `${tab}:topic:${ws.id}:${t.slug}`,
      label: t.title,
      description: describeTopic(t),
      tooltip: `${t.title} (${t.slug}) — ${t.status}`,
      icon: iconForType(t.topic_type, typeMap),
      openUri: `working-memory:/topic/${t.slug}.md`,
      status: t.status,
      focused: t.focused === 1,
      recentEntryCount: t.entry_count_in_workstream,
      actions: topicActions(t.slug, ws.slug),
      alertCount: bubble?.count ?? 0,
      alertSeverity: bubble?.severity ?? null,
    };
    panelBySlug.set(t.slug, panel);
    ordered.push(panel);
  }

  // Nest children under their parent when both are linked to this workstream.
  // A topic with multiple in-set parents nests under the first one returned
  // by listTopicParents (newest link wins, matching that query's ORDER BY).
  const slugSet = new Set(panelBySlug.keys());
  const childrenBySlug = new Map<string, string[]>();
  const rootSlugs: string[] = [];
  for (const t of topics) {
    const inSetParent = store
      .listTopicParents(t.slug)
      .find((p) => slugSet.has(p.slug) && p.slug !== t.slug);
    if (inSetParent) {
      const arr = childrenBySlug.get(inSetParent.slug) ?? [];
      arr.push(t.slug);
      childrenBySlug.set(inSetParent.slug, arr);
    } else {
      rootSlugs.push(t.slug);
    }
  }

  const attach = (slug: string, path: Set<string>, depth: number): void => {
    if (depth >= MAX_TOPIC_DEPTH) {
      return;
    }
    const kids = (childrenBySlug.get(slug) ?? []).filter((s) => !path.has(s));
    if (kids.length === 0) {
      return;
    }
    const panel = panelBySlug.get(slug);
    if (!panel) {
      return;
    }
    panel.children = kids.map((s) => panelBySlug.get(s)!);
    for (const s of kids) {
      const next = new Set(path);
      next.add(s);
      attach(s, next, depth + 1);
    }
  };

  for (const s of rootSlugs) {
    attach(s, new Set([s]), 1);
  }

  const children = rootSlugs.map((s) => panelBySlug.get(s)!);

  return {
    group: {
      kind: 'topics-group',
      id: `${tab}:topics-group:${ws.id}`,
      label: topics.length > 0 ? `Topics (${topics.length})` : 'Topics',
      description: topics.length > 0 ? undefined : 'none linked',
      icon: FALLBACK_GROUP_ICON,
      collapsible: topics.length > 0,
      children,
    },
    orderedTopics: ordered,
  };
}

function buildSessions(
  store: JournalStore,
  tab: PanelTab,
  ws: WorkstreamWithCount,
): PanelSessionsGroup {
  const allSessions = store.listSessionsForWorkstream(ws.id);
  const sessions =
    tab === 'active' ? allSessions.filter((s) => s.ended_at == null) : allSessions;
  const children: PanelSession[] = sessions.map((s) =>
    buildSessionRow(store, tab, ws.id, s),
  );
  return {
    kind: 'sessions-group',
    id: `${tab}:sessions-group:${ws.id}`,
    label:
      sessions.length > 0 ? `Sessions (${sessions.length})` : 'Sessions',
    description: sessions.length > 0 ? undefined : 'none logged',
    icon: SESSIONS_GROUP_ICON,
    collapsible: sessions.length > 0,
    children,
  };
}

function buildSessionRow(
  store: JournalStore,
  tab: PanelTab,
  workstreamId: number,
  s: Session,
): PanelSession {
  const started = formatStarted(s.started_at);
  const entryCount = store.listEntriesForSession(s.session_id).length;
  const summary = s.summary?.trim();
  const label = summary && summary.length > 0 ? summary : started;
  const descParts: string[] = [];
  if (summary && summary.length > 0) {
    descParts.push(started);
  }
  descParts.push(
    `${entryCount} entr${entryCount === 1 ? 'y' : 'ies'}`,
  );
  if (!s.ended_at) {
    descParts.push('in progress');
  }
  const tooltipLines: string[] = [`Session ${s.session_id}`, `Started ${started}`];
  if (s.ended_at) {
    tooltipLines.push(`Ended ${formatStarted(s.ended_at)}`);
  } else {
    tooltipLines.push('In progress');
  }
  if (summary) {
    tooltipLines.push('', summary);
  }
  return {
    kind: 'session',
    id: `${tab}:session:${workstreamId}:${s.session_id}`,
    label,
    description: descParts.join(' • '),
    tooltip: tooltipLines.join('\n'),
    icon: SESSION_ROW_ICON,
    openUri: `working-memory:/session/${s.session_id}.md`,
    recentEntryCount: entryCount,
  };
}

/** ISO-ish local timestamp for session rows; no per-row tz conversion. */
function formatStarted(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) {
    return '—';
  }
  const d = new Date(unixSeconds * 1000);
  const date = d.toLocaleDateString('en-CA');
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${date} ${time}`;
}

/**
 * Active-tab "send to section" actions for a workstream's context menu.
 * Omits the section the workstream is already in. Each invokes the
 * `working-memory.setWorkstreamSection` command (registered in extension.ts),
 * which patches the lifecycle `status` via the control-plane workstream domain
 * layer (WM 13.0 "rehome-wm-tools") and refreshes the panel.
 */
function sectionMoveActions(ws: { slug: string; status: string }): PanelAction[] {
  const current = sectionForStatus(ws.status);
  // Vertical order of the sections, top → bottom. A move to a smaller index is
  // "up", a larger index is "down" — picks the matching arrow-circle glyph.
  const orderIndex: Record<WorkstreamSection, number> = {
    queue: 0,
    progress: 1,
    backlog: 2,
  };
  const currentIndex = orderIndex[current];
  const targets: { section: WorkstreamSection; title: string }[] = [
    { section: 'queue', title: 'Send to Queue' },
    { section: 'progress', title: 'Send to In Progress' },
    { section: 'backlog', title: 'Send to Backlog' },
  ];
  return targets
    .filter((t) => t.section !== current)
    .map((t) => ({
      command: 'working-memory.setWorkstreamSection',
      title: t.title,
      args: [{ slug: ws.slug, section: t.section }],
      icon:
        orderIndex[t.section] < currentIndex
          ? 'arrow-circle-up'
          : 'arrow-circle-down',
    }));
}

function buildWorkstream(
  store: JournalStore,
  tab: PanelTab,
  ws: WorkstreamWithCount,
  typeMap: Map<string, TopicType>,
): PanelWorkstream {
  const baseTooltip = `${ws.title} (${ws.slug}) — ${ws.status}`;
  const tooltip = ws.closure?.trim()
    ? `${baseTooltip}\n\n${ws.closure.trim()}`
    : baseTooltip;
  const description =
    tab === 'archive' && ws.closure?.trim() ? ws.closure.trim() : '';
  const actions: PanelAction[] =
    tab === 'archive'
      ? [
          {
            command: 'working-memory.reopenWorkstream',
            title: 'Reopen Workstream',
            args: [{ slug: ws.slug }],
          },
        ]
      : sectionMoveActions(ws);
  const { group: topicsGroup, orderedTopics } = buildTopics(
    store,
    tab,
    ws,
    typeMap,
  );
  const sessionsGroup = buildSessions(store, tab, ws);
  const recentEntryCount = store.countRecentEntriesForWorkstream(
    ws.id,
    ALL_TIME_SINCE,
  );
  const focusedTopics = orderedTopics.filter((t) => t.focused);
  const wsBubble = workstreamAlertBubble(store, ws.id);
  return {
    kind: 'workstream',
    id: `${tab}:workstream:${ws.id}`,
    label: ws.title,
    description,
    tooltip,
    openUri: `working-memory:/workstream/${ws.slug}.md`,
    recentEntryCount,
    section: sectionForStatus(ws.status),
    alertCount: wsBubble?.count ?? 0,
    alertSeverity: wsBubble?.severity ?? null,
    actions,
    focused_topics: focusedTopics,
    children: [
      topicsGroup,
      sessionsGroup,
    ],
  };
}

function buildTopicRow(
  t: TopicWithCounts | Topic,
  parentSlug: string | null,
  countsBySlug: Map<string, TopicWithCounts>,
  typeMap: Map<string, TopicType>,
  store: JournalStore,
): PanelTopicRow {
  const counts = countsBySlug.get(t.slug);
  const description = counts
    ? describeTopicRow(counts)
    : describeTopicRow({
        ...(t as Topic),
        workstream_count: 0,
        entry_count: 0,
      } as TopicWithCounts);
  const bubble = alertBubble(store, t.slug);
  return {
    kind: 'topic-row',
    id: `topics:topic:${parentSlug ?? 'root'}:${t.slug}`,
    label: t.title,
    description,
    tooltip: `${t.title} (${t.slug}) — ${t.status}`,
    icon: iconForType(t.topic_type, typeMap),
    openUri: `working-memory:/topic/${t.slug}.md`,
    status: t.status,
    recentEntryCount: counts?.entry_count ?? 0,
    actions: topicActions(t.slug),
    alertCount: bubble?.count ?? 0,
    alertSeverity: bubble?.severity ?? null,
  };
}

const MAX_TOPIC_DEPTH = 20;

function attachChildren(
  store: JournalStore,
  row: PanelTopicRow,
  parentSlug: string,
  countsBySlug: Map<string, TopicWithCounts>,
  typeMap: Map<string, TopicType>,
  path: Set<string>,
  depth: number,
): void {
  if (depth >= MAX_TOPIC_DEPTH) {
    return;
  }
  const children = store
    .listTopicChildren(parentSlug)
    .filter((c) => c.status === 'open' && c.deleted_at === null)
    .filter((c) => !path.has(c.slug));
  if (children.length === 0) {
    return;
  }
  row.children = children.map((c) => {
    const childRow = buildTopicRow(
      c,
      parentSlug,
      countsBySlug,
      typeMap,
      store,
    );
    const nextPath = new Set(path);
    nextPath.add(c.slug);
    attachChildren(
      store,
      childRow,
      c.slug,
      countsBySlug,
      typeMap,
      nextPath,
      depth + 1,
    );
    return childRow;
  });
}

function loadTypeMap(store: JournalStore): Map<string, TopicType> {
  return new Map(store.listTopicTypes().map((t) => [t.id, t]));
}

export function getPanelTopicsData(store: JournalStore): PanelData {
  const typeMap = loadTypeMap(store);
  const open = store.listTopics({ status: 'open' });
  const countsBySlug = new Map<string, TopicWithCounts>(
    open.map((t) => [t.slug, t]),
  );
  const roots = open.filter((t) => store.listTopicParents(t.slug).length === 0);
  const items: PanelItem[] = roots.map((t) => {
    const row = buildTopicRow(
      t,
      null,
      countsBySlug,
      typeMap,
      store,
    );
    attachChildren(
      store,
      row,
      t.slug,
      countsBySlug,
      typeMap,
      new Set([t.slug]),
      1,
    );
    return row;
  });
  return {
    tab: 'topics',
    items,
    emptyMessage: 'No open topics.',
  };
}

export function getPanelTopicTypesData(store: JournalStore): PanelData {
  const items: PanelItem[] = store.listTopicTypes().map((type) => {
    const withCount = store.getTopicType(type.id);
    const topicCount = withCount?.topic_count ?? 0;
    return {
      kind: 'topic-type',
      id: `topic-types:type:${type.id}`,
      label: type.label,
      description: `${topicCount} topic${topicCount === 1 ? '' : 's'}`,
      tooltip: `${type.label} (${type.id})`,
      icon: type.icon,
      openUri: `working-memory:/topic-type/${encodeURIComponent(type.id)}.md`,
      topicCount,
    };
  });
  return {
    tab: 'topic-types',
    items,
    emptyMessage: 'No topic types.',
  };
}

/** Codicon for a nanite row; enabled shows a running-bot glyph, disabled dims. */
const NANITE_ICON = 'zap';
/** Codicon for a soft-deleted nanite row surfaced in the deleted list. */
const NANITE_DELETED_ICON = 'trash';

/**
 * Delete / restore context-menu actions for a nanite row. A live nanite offers
 * Delete; a soft-deleted one offers Restore. Mirrors the topic delete/restore
 * mechanism: the panel invokes the command, which calls the store + refreshes.
 */
function naniteActions(slug: string, deleted: boolean): PanelAction[] {
  if (deleted) {
    return [
      {
        command: 'working-memory.nanite.restore',
        title: 'Restore Nanite',
        args: [{ slug }],
        icon: 'history',
      },
    ];
  }
  return [
    {
      command: 'working-memory.nanite.delete',
      title: 'Delete Nanite',
      args: [{ slug }],
      icon: 'trash',
    },
  ];
}

/**
 * All nanites for the top-level Nanites tab — including disabled and
 * soft-deleted rows, so the tab doubles as the deleted list (deleted rows are
 * muted and offer Restore). Mirrors how topics expose delete/restore.
 */
export function getPanelNanitesData(store: JournalStore): PanelData {
  if (!NANITES_ENABLED) {
    return { tab: 'nanites', items: [], emptyMessage: 'Nanites are disabled.' };
  }
  const nanites = new NanitesStore(store.connection).listNanites({
    include_disabled: true,
    include_deleted: true,
  });
  const items: PanelItem[] = nanites.map((n) => {
    const deleted = n.deleted_at !== null;
    const trigger = n.trigger_phrase.trim();
    const descParts: string[] = [
      deleted ? 'deleted' : n.enabled ? 'enabled' : 'disabled',
    ];
    if (trigger) {
      descParts.push(trigger);
    }
    const stateNote = deleted
      ? 'deleted'
      : n.enabled
        ? 'enabled'
        : 'disabled';
    return {
      kind: 'nanite',
      id: `nanites:nanite:${n.slug}`,
      label: n.title.trim() || n.slug,
      description: descParts.join(' • '),
      tooltip: `${n.title} (${n.slug}) — ${stateNote}${
        trigger ? `\ntrigger: ${trigger}` : ''
      }`,
      icon: deleted ? NANITE_DELETED_ICON : NANITE_ICON,
      openUri: `working-memory:/nanite/${encodeURIComponent(n.slug)}.md`,
      enabled: n.enabled,
      deleted,
      actions: naniteActions(n.slug, deleted),
    };
  });
  return { tab: 'nanites', items, emptyMessage: 'No nanites.' };
}

/** Codicon id for a Blackboard document row. */
const DOCUMENT_ROW_ICON = 'file';

/** Build one Blackboard row from a control-plane document envelope. */
function buildDocumentRow(doc: DocumentEnvelope): PanelDocumentRow {
  const id = doc.metadata.id;
  const slug = doc.metadata.slug;
  const idShort = id.slice(0, 8);
  const rv = doc.metadata.resourceVersion;
  return {
    kind: 'document-row',
    id: `blackboard:document:${id}`,
    label: `${doc.kind}: ${slug ?? idShort}`,
    description: `v${rv} • ${idShort}`,
    tooltip: `${doc.kind} ${id}${slug ? ` (${slug})` : ''} — resourceVersion ${rv}`,
    icon: DOCUMENT_ROW_ICON,
    openUri: `working-memory:/document/${encodeURIComponent(id)}.md`,
  };
}

/**
 * Build the Blackboard tab from a `wm-document-read` result. Sourced through
 * the control-plane MCP client (not the journal DB), so the empty state reflects
 * the daemon's reachability: unavailable → "Control plane not running";
 * reachable-but-empty → "No documents yet".
 */
export function buildBlackboardPanelData(result: ListDocumentsResult): PanelData {
  if (!result.available) {
    return {
      tab: 'blackboard',
      items: [],
      emptyMessage: 'Control plane not running.',
    };
  }
  const items: PanelItem[] = result.documents.map(buildDocumentRow);
  return {
    tab: 'blackboard',
    items,
    emptyMessage: 'No documents yet.',
  };
}

export function getPanelData(store: JournalStore, tab: PanelTab): PanelData {
  if (tab === 'topics') {
    return getPanelTopicsData(store);
  }
  if (tab === 'topic-types') {
    return getPanelTopicTypesData(store);
  }
  if (tab === 'nanites') {
    return getPanelNanitesData(store);
  }
  if (tab === 'alerts') {
    return getPanelAlertsData(store);
  }
  const typeMap = loadTypeMap(store);
  if (tab === 'active') {
    return getActivePanelData(store, typeMap);
  }
  const rows = store.listWorkstreams({
    status: 'closed',
    orderBy: 'closed-desc',
  });
  return {
    tab,
    items: rows.map((w) => buildWorkstream(store, tab, w, typeMap)),
    emptyMessage: 'No archived workstreams.',
  };
}

/** Section order (top → bottom) on the Active tab. */
const ACTIVE_SECTIONS: {
  section: WorkstreamSection;
  label: string;
  display: 'cards' | 'shelf';
  emptyMessage: string;
}[] = [
  { section: 'queue', label: 'Queue', display: 'shelf', emptyMessage: 'Queue is empty.' },
  { section: 'progress', label: 'In Progress', display: 'cards', emptyMessage: 'Nothing in progress.' },
  { section: 'backlog', label: 'Backlog', display: 'shelf', emptyMessage: 'Backlog is empty.' },
];

/**
 * Map a stored workstream status to its Active-tab section. Exact section
 * values pass through; everything else non-closed (notably the legacy 'open'
 * value) lands in Progress so nothing silently disappears.
 */
export function sectionForStatus(status: string): WorkstreamSection {
  if (status === 'queue' || status === 'backlog') {
    return status;
  }
  return 'progress';
}

function getActivePanelData(
  store: JournalStore,
  typeMap: Map<string, TopicType>,
): PanelData {
  const rows = store.listWorkstreams({
    status: 'active',
    orderBy: 'position-asc',
  });
  const buckets: Record<WorkstreamSection, PanelWorkstream[]> = {
    queue: [],
    progress: [],
    backlog: [],
  };
  for (const w of rows) {
    buckets[sectionForStatus(w.status)].push(
      buildWorkstream(store, 'active', w, typeMap),
    );
  }
  const items: PanelItem[] = ACTIVE_SECTIONS.map((s) => ({
    kind: 'workstream-section',
    id: `active:section:${s.section}`,
    section: s.section,
    label: s.label,
    display: s.display,
    workstreams: buckets[s.section],
    emptyMessage: s.emptyMessage,
  }));
  return {
    tab: 'active',
    items,
    emptyMessage: 'No active workstreams.',
  };
}

export function getAllPanelData(store: JournalStore): {
  active: PanelData;
  archive: PanelData;
  topics: PanelData;
  topicTypes: PanelData;
  alerts: PanelData;
  nanites: PanelData;
} {
  return {
    active: getPanelData(store, 'active'),
    archive: getPanelData(store, 'archive'),
    topics: getPanelTopicsData(store),
    topicTypes: getPanelTopicTypesData(store),
    alerts: getPanelAlertsData(store),
    nanites: getPanelNanitesData(store),
  };
}

/** All alerts (active + closed) for the Alerts tab (D). */
export function getPanelAlertsData(store: JournalStore): PanelData {
  if (!ALERTS_ENABLED) {
    return { tab: 'alerts', items: [], emptyMessage: 'Alerts are disabled.' };
  }
  const all = new AlertsStore(store.connection).listAlerts({ status: 'all' });
  const items: PanelItem[] = all.map((a) => {
    const descParts: string[] = [a.status];
    if (a.topics.length) {
      descParts.push(a.topics.join(', '));
    }
    return {
      kind: 'alert',
      id: `alerts:alert:${a.id}`,
      label: a.title.trim() || a.description.split('\n')[0] || `Alert #${a.id}`,
      description: descParts.join(' • '),
      tooltip: `Alert #${a.id} — ${a.status}\nby ${a.created_by}\n${a.recommended_action || '(no action)'}`,
      openUri: `working-memory:/alert/${a.id}.md`,
      icon:
        a.status === 'alert'
          ? 'bell'
          : a.status === 'informational'
            ? 'info'
            : 'pass',
      status: a.status,
      topics: a.topics,
      actions: alertActions(a.id, a.status),
    };
  });
  return { tab: 'alerts', items, emptyMessage: 'No alerts.' };
}

/** Empty-data fallback used when no store is available (no hub workspace). */
export function emptyAllPanelData(): {
  active: PanelData;
  archive: PanelData;
  topics: PanelData;
  topicTypes: PanelData;
  alerts: PanelData;
  nanites: PanelData;
} {
  const noHub = 'No hub workspace open — open the folder containing AGENTS.md.';
  return {
    active: { tab: 'active', items: [], emptyMessage: noHub },
    archive: { tab: 'archive', items: [], emptyMessage: noHub },
    topics: { tab: 'topics', items: [], emptyMessage: noHub },
    topicTypes: { tab: 'topic-types', items: [], emptyMessage: noHub },
    alerts: { tab: 'alerts', items: [], emptyMessage: noHub },
    nanites: { tab: 'nanites', items: [], emptyMessage: noHub },
  };
}

// ---------------------------------------------------------------------------
// Control-plane-sourced Active / Archive tabs (WM 13.0 "rehome-wm-tools").
//
// The workstream tabs are being repointed from the journal DB onto the
// control-plane document store. These builders take the already-fetched
// control-plane workstreams (via `client.wsRead`, the ws-* domain API) and
// shape them into the SAME
// PanelWorkstream / PanelWorkstreamSection structures the journal path emits, so
// the webview renderer is unchanged. Per-workstream extras that need the
// topic/entry/session domain layers (still journal-only) are stubbed — see
// buildDomainWorkstreamCard.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Control-plane-sourced topics (WM 13.0 "topic-consumer-repoint").
//
// The Topics tab tree and the per-workstream-card topic groups are repointed
// from the journal `topics` table onto the control-plane Topic kind: membership
// is the flat `spec.workstreams` slug array and the parent→child DAG is the flat
// `spec.parents` slug array (both carried on the mapped ControlPlaneTopic the
// client returns). The journal store is still consulted only for the
// not-yet-migrated enrichments — topic-type icons and open-alert bubbles.
// DEFERRED: entry rollups (no entry domain) render as 0, and the per-workstream
// focus PIN has no control-plane equivalent (every card topic is focused:false).
// ---------------------------------------------------------------------------

/** Empty topic-type map used when no journal store is available for icon lookup. */
const EMPTY_TYPE_MAP: Map<string, TopicType> = new Map();

/**
 * One-line description for a control-plane topic row / card entry. Entry
 * rollups are journal-only (DEFERRED — the entry domain isn't migrated), so the
 * text carries the membership count and a non-open status marker only.
 */
function describeControlPlaneTopic(t: ControlPlaneTopic): string {
  const parts: string[] = [];
  if (t.workstreams.length > 0) {
    parts.push(
      `${t.workstreams.length} workstream${t.workstreams.length === 1 ? '' : 's'}`,
    );
  }
  if (t.status !== 'open') {
    parts.push(t.status);
  }
  return parts.join(' • ');
}

/** Build a Topics-tab row (PanelTopicRow) for a single control-plane topic. */
function buildControlPlaneTopicRow(
  t: ControlPlaneTopic,
  parentSlug: string | null,
  typeMap: Map<string, TopicType>,
  store: JournalStore | null,
): PanelTopicRow {
  const slug = t.slug ?? '';
  const bubble = store ? alertBubble(store, slug) : null;
  return {
    kind: 'topic-row',
    id: `topics:topic:${parentSlug ?? 'root'}:${slug}`,
    label: t.title,
    description: describeControlPlaneTopic(t),
    tooltip: `${t.title} (${slug}) — ${t.status}`,
    icon: iconForType(t.topicType, typeMap),
    openUri: `working-memory:/topic/${slug}.md`,
    status: t.status,
    // TODO: entry↔topic linking is journal-only (DEFERRED) — no entry rollup.
    recentEntryCount: 0,
    actions: topicActions(slug),
    alertCount: bubble?.count ?? 0,
    alertSeverity: bubble?.severity ?? null,
  };
}

/**
 * Recursively attach control-plane child topics onto a Topics-tab row, walking
 * the parent→children adjacency built from the flat `spec.parents` refs. Guarded
 * by a visited-path set (cycle safety) and {@link MAX_TOPIC_DEPTH}.
 */
function attachControlPlaneChildren(
  row: PanelTopicRow,
  parentSlug: string,
  childrenBySlug: Map<string, ControlPlaneTopic[]>,
  typeMap: Map<string, TopicType>,
  store: JournalStore | null,
  path: Set<string>,
  depth: number,
): void {
  if (depth >= MAX_TOPIC_DEPTH) {
    return;
  }
  const children = (childrenBySlug.get(parentSlug) ?? []).filter(
    (c) => (c.slug ?? '') !== '' && !path.has(c.slug as string),
  );
  if (children.length === 0) {
    return;
  }
  row.children = children.map((c) => {
    const childSlug = c.slug as string;
    const childRow = buildControlPlaneTopicRow(c, parentSlug, typeMap, store);
    const nextPath = new Set(path);
    nextPath.add(childSlug);
    attachControlPlaneChildren(
      childRow,
      childSlug,
      childrenBySlug,
      typeMap,
      store,
      nextPath,
      depth + 1,
    );
    return childRow;
  });
}

/**
 * Build the Topics tab from the control-plane topic list (WM 13.0
 * "topic-consumer-repoint"). Mirrors the journal {@link getPanelTopicsData}:
 * only OPEN topics are shown, rooted at the parentless ones, with the DAG walked
 * top-down via the flat `spec.parents` refs. `available:false` (daemon down)
 * renders the "control plane not running" empty state.
 */
export function buildTopicsPanel(input: {
  available: boolean;
  topics: ControlPlaneTopic[];
  store?: JournalStore | null;
  error?: string;
}): PanelData {
  if (!input.available) {
    return { tab: 'topics', items: [], emptyMessage: 'Control plane not running.' };
  }
  const store = input.store ?? null;
  const typeMap = store ? loadTypeMap(store) : EMPTY_TYPE_MAP;
  const open = input.topics.filter(
    (t) => t.status === 'open' && (t.slug ?? '') !== '',
  );
  // Invert the flat parent refs into a parent→children adjacency map. Values are
  // open topics; keys may reference closed/absent parents, but the tree is only
  // walked from parentless open roots, so such dangling refs are skipped — the
  // same orphaning the journal tree exhibits for a child whose only parent is
  // closed.
  const childrenBySlug = new Map<string, ControlPlaneTopic[]>();
  for (const t of open) {
    for (const p of t.parents) {
      const arr = childrenBySlug.get(p) ?? [];
      arr.push(t);
      childrenBySlug.set(p, arr);
    }
  }
  const roots = open.filter((t) => t.parents.length === 0);
  const items: PanelItem[] = roots.map((t) => {
    const slug = t.slug as string;
    const row = buildControlPlaneTopicRow(t, null, typeMap, store);
    attachControlPlaneChildren(
      row,
      slug,
      childrenBySlug,
      typeMap,
      store,
      new Set([slug]),
      1,
    );
    return row;
  });
  return { tab: 'topics', items, emptyMessage: 'No open topics.' };
}

/**
 * Build the per-workstream-card "Topics" group from the control-plane topics
 * whose `spec.workstreams` membership includes `wsSlug`. Nests a member under
 * the first of its `spec.parents` that is ALSO a member (mirroring the journal
 * {@link buildTopics} in-set nesting). The per-workstream focus PIN is DEFERRED
 * (no control-plane `focused` flag) so every entry is `focused:false`.
 */
function buildControlPlaneCardTopics(
  wsSlug: string,
  wsId: string,
  tab: 'active' | 'archive',
  members: ControlPlaneTopic[],
  typeMap: Map<string, TopicType>,
  store: JournalStore | null,
): PanelTopicsGroup {
  const panelBySlug = new Map<string, PanelTopic>();
  const orderedSlugs: string[] = [];
  for (const t of members) {
    const slug = t.slug ?? '';
    if (slug === '') {
      continue;
    }
    const bubble = store ? alertBubble(store, slug) : null;
    panelBySlug.set(slug, {
      kind: 'topic',
      id: `${tab}:topic:${wsId}:${slug}`,
      label: t.title,
      description: describeControlPlaneTopic(t),
      tooltip: `${t.title} (${slug}) — ${t.status}`,
      icon: iconForType(t.topicType, typeMap),
      openUri: `working-memory:/topic/${slug}.md`,
      status: t.status,
      // TODO: per-workstream focus pin is DEFERRED — control-plane membership
      // has no `focused` flag, so this renders plain (unfocused) membership.
      focused: false,
      recentEntryCount: 0,
      actions: topicActions(slug, wsSlug),
      alertCount: bubble?.count ?? 0,
      alertSeverity: bubble?.severity ?? null,
    });
    orderedSlugs.push(slug);
  }
  // Nest a member under the first of its parents that is also a member of this
  // workstream (matches the journal card's in-set nesting).
  const slugSet = new Set(panelBySlug.keys());
  const childrenBySlug = new Map<string, string[]>();
  const rootSlugs: string[] = [];
  for (const t of members) {
    const slug = t.slug ?? '';
    if (slug === '' || !slugSet.has(slug)) {
      continue;
    }
    const inSetParent = t.parents.find((p) => slugSet.has(p) && p !== slug);
    if (inSetParent) {
      const arr = childrenBySlug.get(inSetParent) ?? [];
      arr.push(slug);
      childrenBySlug.set(inSetParent, arr);
    } else {
      rootSlugs.push(slug);
    }
  }
  const attach = (slug: string, path: Set<string>, depth: number): void => {
    if (depth >= MAX_TOPIC_DEPTH) {
      return;
    }
    const kids = (childrenBySlug.get(slug) ?? []).filter((s) => !path.has(s));
    if (kids.length === 0) {
      return;
    }
    const panel = panelBySlug.get(slug);
    if (!panel) {
      return;
    }
    panel.children = kids.map((s) => panelBySlug.get(s) as PanelTopic);
    for (const s of kids) {
      const next = new Set(path);
      next.add(s);
      attach(s, next, depth + 1);
    }
  };
  for (const s of rootSlugs) {
    attach(s, new Set([s]), 1);
  }
  const children = rootSlugs.map((s) => panelBySlug.get(s) as PanelTopic);
  const count = orderedSlugs.length;
  return {
    kind: 'topics-group',
    id: `${tab}:topics-group:${wsId}`,
    label: count > 0 ? `Topics (${count})` : 'Topics',
    description: count > 0 ? undefined : 'none linked',
    icon: FALLBACK_GROUP_ICON,
    collapsible: count > 0,
    children,
  };
}

/**
 * Build a simplified Active/Archive workstream CARD from a control-plane
 * Workstream document. The per-workstream "Topics" group is populated from the
 * control-plane topic membership (`spec.workstreams`) when `topics` is supplied;
 * absent → the group is omitted (backward-compat for callers that don't fetch
 * topics, e.g. the pure-builder unit tests). Extras that still require the
 * not-yet-migrated entry / session domain layers — recent-entry counts, the
 * sessions group, alert bubbles — are stubbed to empty/zero. The per-workstream
 * focused-topic PIN is DEFERRED: control-plane membership carries no `focused`
 * flag, so `focused_topics` is always empty and every card topic is
 * `focused:false`.
 */
function buildDomainWorkstreamCard(
  ws: Workstream,
  tab: 'active' | 'archive',
  topics: ControlPlaneTopic[] | undefined,
  typeMap: Map<string, TopicType>,
  store: JournalStore | null,
): PanelWorkstream {
  const slug = ws.slug ?? '';
  const status = ws.status;
  const baseTooltip = `${ws.title} (${slug || '∅'}) — ${status}`;
  const tooltip = ws.closure?.trim()
    ? `${baseTooltip}\n\n${ws.closure.trim()}`
    : baseTooltip;
  const description =
    tab === 'archive' && ws.closure?.trim() ? ws.closure.trim() : '';
  // Section-move (active) / reopen (archive) actions target a command by slug;
  // omit them for the (unexpected) slugless document rather than emit a broken
  // command.
  const actions: PanelAction[] =
    slug.length === 0
      ? []
      : tab === 'archive'
        ? [
            {
              command: 'working-memory.reopenWorkstream',
              title: 'Reopen Workstream',
              args: [{ slug }],
            },
          ]
        : sectionMoveActions({ slug, status });
  // Populate the per-card Topics group from control-plane membership when the
  // topic list was fetched. Only the topics group is added — the sessions group
  // needs the (not-yet-migrated) session domain layer.
  const children: (PanelTopicsGroup | PanelSessionsGroup)[] = [];
  if (topics !== undefined && slug.length > 0) {
    const members = topics.filter((t) => t.workstreams.includes(slug));
    children.push(
      buildControlPlaneCardTopics(slug, ws.id, tab, members, typeMap, store),
    );
  }
  return {
    kind: 'workstream',
    // Document uuid keeps the id stable across refreshes (webview expand key).
    id: `${tab}:workstream:${ws.id}`,
    label: ws.title,
    description,
    tooltip,
    // Opens the raw envelope via the same control-plane-backed virtual doc the
    // Blackboard tab uses, so a card is clickable pre-migration.
    // TODO: point at a dedicated workstream virtual doc once the content
    // provider is repointed onto the control-plane.
    openUri: `working-memory:/document/${encodeURIComponent(ws.id)}.md`,
    // TODO: needs topic/entry domain layer — no recent-activity count yet.
    recentEntryCount: 0,
    ...(tab === 'active' ? { section: sectionForStatus(status) } : {}),
    // TODO: needs alert domain layer — no alert bubble yet.
    alertCount: 0,
    alertSeverity: null,
    actions,
    // TODO: per-workstream focus pin is DEFERRED (control-plane membership has
    // no focus flag) — no pinned focused topics.
    focused_topics: [],
    children,
  };
}

export interface WorkstreamPanels {
  active: PanelData;
  archive: PanelData;
}

/**
 * Build the Active + Archive tabs from the control-plane workstream domain
 * layer. Mirrors {@link buildBlackboardPanelData} for the other
 * control-plane-sourced tab: `available:false` (daemon down) renders both tabs
 * with the same "control plane not running" empty state; otherwise workstreams
 * are grouped by lifecycle status — queue/progress/backlog → the three Active
 * sections, closed → Archive. Ordering within a group follows the store's
 * newest-first list order (manual position isn't migrated yet).
 *
 * When `topics` (the control-plane topic list from `client.topicRead`) is
 * supplied, each card's "Topics" group is populated from `spec.workstreams`
 * membership (WM 13.0 "topic-consumer-repoint"); `store` is used purely for the
 * journal-sourced enrichments that aren't migrated yet (topic-type icons, alert
 * bubbles) and degrades gracefully when null.
 */
export function buildWorkstreamPanels(input: {
  available: boolean;
  workstreams: Workstream[];
  topics?: ControlPlaneTopic[];
  store?: JournalStore | null;
  error?: string;
}): WorkstreamPanels {
  if (!input.available) {
    return {
      active: { tab: 'active', items: [], emptyMessage: 'Control plane not running.' },
      archive: { tab: 'archive', items: [], emptyMessage: 'Control plane not running.' },
    };
  }
  const store = input.store ?? null;
  const typeMap = store ? loadTypeMap(store) : EMPTY_TYPE_MAP;
  const buckets: Record<WorkstreamSection, PanelWorkstream[]> = {
    queue: [],
    progress: [],
    backlog: [],
  };
  const archived: PanelWorkstream[] = [];
  for (const ws of input.workstreams) {
    if (ws.status === 'closed') {
      archived.push(
        buildDomainWorkstreamCard(ws, 'archive', input.topics, typeMap, store),
      );
    } else {
      buckets[sectionForStatus(ws.status)].push(
        buildDomainWorkstreamCard(ws, 'active', input.topics, typeMap, store),
      );
    }
  }
  const activeItems: PanelItem[] = ACTIVE_SECTIONS.map((s) => ({
    kind: 'workstream-section',
    id: `active:section:${s.section}`,
    section: s.section,
    label: s.label,
    display: s.display,
    workstreams: buckets[s.section],
    emptyMessage: s.emptyMessage,
  }));
  return {
    active: { tab: 'active', items: activeItems, emptyMessage: 'No active workstreams.' },
    archive: {
      tab: 'archive',
      items: archived,
      emptyMessage: 'No archived workstreams.',
    },
  };
}
