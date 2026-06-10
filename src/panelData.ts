import {
  JournalStore,
  type Session,
  type Topic,
  type TopicType,
  type TopicWithCounts,
  type WorkstreamTopicRow,
  type WorkstreamWithCount,
} from './db';
import { TRAVERSAL_MODES } from './graphTraversals';

/**
 * Plain-JSON shapes shipped to the webview. Keep these serializable —
 * nothing in here may reference `vscode.*` types or DB row objects directly.
 */
export type PanelTab = 'active' | 'archive' | 'topics';

export interface PanelAction {
  /** VS Code command id to invoke. */
  command: string;
  /** Human-readable label for the quick-pick / menu. */
  title: string;
  /** Optional secondary text shown in the quick-pick. */
  description?: string;
  /** Args to pass to the command. */
  args?: unknown[];
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
  icon: 'repo';
  openUri: string;
  recentEntryCount: number;
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
  children?: PanelTopicRow[];
}

export type PanelItem = PanelWorkstream | PanelTopicRow;

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
  const parts: string[] = [t.slug];
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
  const parts: string[] = [t.slug];
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

function topicActions(topicSlug: string, workstreamSlug?: string): PanelAction[] {
  const add = Object.values(TRAVERSAL_MODES).map((mode) => ({
    command: 'workingMemory.topic.addToWorkstream',
    title: `Add to workstream ▸ ${mode.label}`,
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
    tab === 'archive' && ws.closure?.trim() ? ws.closure.trim() : ws.slug;
  const actions: PanelAction[] =
    tab === 'archive'
      ? [
          {
            command: 'working-memory.reopenWorkstream',
            title: 'Reopen Workstream',
            args: [{ slug: ws.slug }],
          },
        ]
      : [];
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
  return {
    kind: 'workstream',
    id: `${tab}:workstream:${ws.id}`,
    label: ws.title,
    description,
    tooltip,
    icon: 'repo',
    openUri: `working-memory:/workstream/${ws.slug}.md`,
    recentEntryCount,
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
): PanelTopicRow {
  const counts = countsBySlug.get(t.slug);
  const description = counts
    ? describeTopicRow(counts)
    : describeTopicRow({
        ...(t as Topic),
        workstream_count: 0,
        entry_count: 0,
      } as TopicWithCounts);
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

export function getPanelData(store: JournalStore, tab: PanelTab): PanelData {
  if (tab === 'topics') {
    return getPanelTopicsData(store);
  }
  const typeMap = loadTypeMap(store);
  const rows =
    tab === 'active'
      ? store.listWorkstreams({
          status: 'open',
          orderBy: 'last-activity-desc',
        })
      : store.listWorkstreams({ status: 'closed', orderBy: 'closed-desc' });
  return {
    tab,
    items: rows.map((w) => buildWorkstream(store, tab, w, typeMap)),
    emptyMessage:
      tab === 'active'
        ? 'No active workstreams.'
        : 'No archived workstreams.',
  };
}

export function getAllPanelData(store: JournalStore): {
  active: PanelData;
  archive: PanelData;
  topics: PanelData;
} {
  return {
    active: getPanelData(store, 'active'),
    archive: getPanelData(store, 'archive'),
    topics: getPanelTopicsData(store),
  };
}

/** Empty-data fallback used when no store is available (no hub workspace). */
export function emptyAllPanelData(): {
  active: PanelData;
  archive: PanelData;
  topics: PanelData;
} {
  const noHub = 'No hub workspace open — open the folder containing AGENTS.md.';
  return {
    active: { tab: 'active', items: [], emptyMessage: noHub },
    archive: { tab: 'archive', items: [], emptyMessage: noHub },
    topics: { tab: 'topics', items: [], emptyMessage: noHub },
  };
}
