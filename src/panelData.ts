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

/**
 * Plain-JSON shapes shipped to the webview. Keep these serializable —
 * nothing in here may reference `vscode.*` types or DB row objects directly.
 */
export type PanelTab = 'active' | 'archive' | 'topics' | 'topic-types' | 'alerts' | 'nanites';

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

export type PanelItem =
  | PanelWorkstream
  | PanelWorkstreamSection
  | PanelTopicRow
  | PanelTopicType
  | PanelAlert
  | PanelNanite;

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
 * which patches `status` via `store.updateWorkstream` and refreshes the panel.
 */
function sectionMoveActions(ws: WorkstreamWithCount): PanelAction[] {
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
    orderBy: 'last-activity-desc',
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
