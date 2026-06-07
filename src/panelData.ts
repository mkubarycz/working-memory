import {
  listTopicChildren,
  listTopicParents,
  listTopics,
  listTopicsForWorkstream,
  listTopicTypes,
  listWorkstreams,
  type Topic,
  type TopicType,
  type TopicWithCounts,
  type WorkstreamTopicRow,
  type WorkstreamWithCount,
} from './db';

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

export interface PanelWorkstream {
  kind: 'workstream';
  id: string;
  label: string;
  description: string;
  tooltip: string;
  icon: 'repo';
  openUri: string;
  actions: PanelAction[];
  children: PanelTopicsGroup[];
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

/** Look up icon for a topic_type id, falling back to FALLBACK_TOPIC_ICON. */
function iconForType(
  typeId: string,
  typeMap: Map<string, TopicType>,
): string {
  return typeMap.get(typeId)?.icon ?? FALLBACK_TOPIC_ICON;
}

/**
 * Build a single PanelTopicsGroup for a workstream containing all linked
 * topics as flat children (pre-0.8.0 shape). Per-row icons are sourced
 * from `topic_types.icon` via `iconForType` so the type is still visually
 * disambiguated at the row level, but no per-type bucketing happens.
 */
function buildTopics(
  tab: PanelTab,
  ws: WorkstreamWithCount,
  typeMap: Map<string, TopicType>,
): PanelTopicsGroup {
  const topics = listTopicsForWorkstream(ws.id);
  const children: PanelTopic[] = topics.map((t) => ({
    kind: 'topic',
    id: `${tab}:topic:${ws.id}:${t.slug}`,
    label: t.title,
    description: describeTopic(t),
    tooltip: `${t.title} (${t.slug}) — ${t.status}`,
    icon: iconForType(t.topic_type, typeMap),
    openUri: `working-memory:/topic/${t.slug}.md`,
    status: t.status,
  }));
  return {
    kind: 'topics-group',
    id: `${tab}:topics-group:${ws.id}`,
    label: topics.length > 0 ? `Topics (${topics.length})` : 'Topics',
    description: topics.length > 0 ? undefined : 'none linked',
    icon: FALLBACK_GROUP_ICON,
    collapsible: topics.length > 0,
    children,
  };
}

function buildWorkstream(
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
  return {
    kind: 'workstream',
    id: `${tab}:workstream:${ws.id}`,
    label: ws.title,
    description,
    tooltip,
    icon: 'repo',
    openUri: `working-memory:/workstream/${ws.slug}.md`,
    actions,
    children: [buildTopics(tab, ws, typeMap)],
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
  };
}

const MAX_TOPIC_DEPTH = 20;

/**
 * Recursively populate `children` on a topic row by walking active
 * `listTopicChildren` links. Only open + non-deleted children are kept
 * (the Topics tab is the "open" view).
 *
 * `path` tracks the slugs from the current root down to this node so we
 * can defensively break any unexpected cycle without infinite recursion.
 * The DB rejects cycles at write time, but render-side guarding makes
 * the panel robust to drift (e.g. someone editing the DB by hand).
 */
function attachChildren(
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
  const children = listTopicChildren(parentSlug)
    .filter((c) => c.status === 'open' && c.deleted_at === null)
    .filter((c) => !path.has(c.slug));
  if (children.length === 0) {
    return;
  }
  row.children = children.map((c) => {
    const childRow = buildTopicRow(c, parentSlug, countsBySlug, typeMap);
    const nextPath = new Set(path);
    nextPath.add(c.slug);
    attachChildren(childRow, c.slug, countsBySlug, typeMap, nextPath, depth + 1);
    return childRow;
  });
}

/** Build the id→TopicType lookup used by every render path. */
function loadTypeMap(): Map<string, TopicType> {
  return new Map(listTopicTypes().map((t) => [t.id, t]));
}

export function getPanelTopicsData(): PanelData {
  const typeMap = loadTypeMap();
  const open = listTopics({ status: 'open' });
  const countsBySlug = new Map<string, TopicWithCounts>(
    open.map((t) => [t.slug, t]),
  );
  // Roots = open topics with no active parent links.
  const roots = open.filter((t) => listTopicParents(t.slug).length === 0);
  const items: PanelItem[] = roots.map((t) => {
    const row = buildTopicRow(t, null, countsBySlug, typeMap);
    attachChildren(row, t.slug, countsBySlug, typeMap, new Set([t.slug]), 1);
    return row;
  });
  return {
    tab: 'topics',
    items,
    emptyMessage: 'No open topics.',
  };
}

export function getPanelData(tab: PanelTab): PanelData {
  if (tab === 'topics') {
    return getPanelTopicsData();
  }
  const typeMap = loadTypeMap();
  const rows =
    tab === 'active'
      ? listWorkstreams({ status: 'open', orderBy: 'last-activity-desc' })
      : listWorkstreams({ status: 'closed', orderBy: 'closed-desc' });
  return {
    tab,
    items: rows.map((w) => buildWorkstream(tab, w, typeMap)),
    emptyMessage:
      tab === 'active'
        ? 'No active workstreams.'
        : 'No archived workstreams.',
  };
}

export function getAllPanelData(): {
  active: PanelData;
  archive: PanelData;
  topics: PanelData;
} {
  return {
    active: getPanelData('active'),
    archive: getPanelData('archive'),
    topics: getPanelTopicsData(),
  };
}
