/**
 * Plain-JSON panel data shipped to the webview, sourced PURELY from the
 * control-plane document store (WM journal rip-out). Every builder here is a
 * pure function of already-fetched control-plane values (workstreams, topics,
 * alerts, documents — the shapes `ControlPlaneClient` returns); nothing
 * references `vscode.*` or a journal DB. The Active/Archive/Topics/Blackboard
 * tabs are all assembled from these builders.
 *
 * Keep these shapes serializable — they cross the webview boundary as JSON.
 */

import type {
  AgentMessage as ControlPlaneAlert,
  DocumentEnvelope,
  ListDocumentsResult,
  Topic as ControlPlaneTopic,
  TopicType,
  Workstream,
} from './controlPlaneClient';
import { agentMessageBubbleForTopic, agentMessageBubbleForTopics } from './viewModels/agentMessageVms';

/** The three Active-tab lifecycle sections a workstream can live in. */
export type WorkstreamSection = 'queue' | 'progress' | 'backlog';

export type PanelTab =
  | 'active'
  | 'archive'
  | 'topics'
  | 'topic-types'
  | 'alerts'
  | 'agent-messages'
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
  /** When false, the row's context-menu item renders disabled (default true). */
  enabled?: boolean;
}

export interface PanelTopic {
  kind: 'topic';
  id: string;
  /** Canonical Topic ID; id above remains the stable UI row identity. */
  documentId?: string;
  label: string;
  description: string;
  tooltip: string;
  /** Codicon id (e.g. 'rocket', 'checklist'). Sourced from topic-type icons. */
  icon: string;
  openUri: string;
  status: 'open' | 'closed';
  recentEntryCount: number;
  actions?: PanelAction[];
  /** Whether this topic is focused/pinned in the parent workstream. */
  focused: boolean;
  /** Open-alert count for the bubble (A); 0 hides it. */
  agentMessageCount?: number;
  /** Max severity among open alerts: 'alert' reddish, 'informational' default. */
  agentMessageSeverity?: 'info' | 'warning' | 'error' | null;
  /** Nested child topics — only set when non-empty. */
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

export interface PanelWorkstream {
  kind: 'workstream';
  id: string;
  /** The workstream's stable id (null when it has none). */

  label: string;
  description: string;
  tooltip: string;
  openUri: string;
  recentEntryCount: number;
  /** Active-tab section this workstream currently lives in. */
  section?: WorkstreamSection;
  /** Open-alert count aggregated across the workstream's linked topics; 0 hides the bubble. */
  agentMessageCount?: number;
  /** Max severity among open alerts: 'alert' reddish, 'informational' default. */
  agentMessageSeverity?: 'info' | 'warning' | 'error' | null;
  actions: PanelAction[];
  /** Focused topics for this workstream, in membership order. */
  focused_topics: PanelTopic[];
  children: PanelTopicsGroup[];
}

/**
 * One of the three vertically-stacked groups on the Active tab. `progress`
 * renders its workstreams as full cards; `queue` and `backlog` render as a
 * compact "peek shelf".
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
  /** Codicon id (per-topic, sourced from topic-type icons). */
  icon: string;
  openUri: string;
  status: 'open' | 'closed';
  recentEntryCount: number;
  actions?: PanelAction[];
  agentMessageCount?: number;
  agentMessageSeverity?: 'info' | 'warning' | 'error' | null;
  children?: PanelTopicRow[];
}

/**
 * A Blackboard-tab row: one control-plane document envelope, sourced through
 * the MCP `wm-document-read` tool. Mirrors the visual shape of `PanelTopicRow`
 * so the webview renders it with the same row path.
 */
export interface PanelDocumentRow {
  kind: 'document-row';
  id: string;
  label: string;
  description: string;
  tooltip: string;
  /** Codicon id. */
  icon: string;
  /** `working-memory:/document/<id>.working-memory` unified-editor URI. */
  openUri: string;
}

export type PanelItem =
  | PanelWorkstream
  | PanelWorkstreamSection
  | PanelTopicRow
  | PanelDocumentRow
  | PanelAgentMessage
  | PanelTopicType;

/** A Topic-Types-tab row: one control-plane topic type as a flat, clickable row. */
export interface PanelTopicType {
  kind: 'topic-type';
  id: string;
  label: string;
  description: string;
  /** Codicon id (the type's own icon, falling back to the shape icon). */
  icon: string;
  tooltip: string;
  /** `working-memory:/topic-type/<id>.working-memory` unified-editor URI. */
  openUri: string;
}

/** A canonical agent-message history row. */
export interface PanelAgentMessage {
  kind: 'agent-message';
  id: string;
  label: string;
  description: string;
  /** Lifecycle and severity are independent. */
  status: ControlPlaneAlert['status'];
  category: ControlPlaneAlert['category'];
  severity: ControlPlaneAlert['severity'];
  attention: boolean;
  /** Codicon id. */
  icon: string;
  tooltip: string;
  /** Canonical internal document URI; historical alert routes remain readable. */
  openUri: string;
}

/** @deprecated Use PanelAgentMessage. */
export type PanelAlert = PanelAgentMessage;

export interface PanelData {
  tab: PanelTab;
  items: PanelItem[];
  emptyMessage: string;
  /** Open topics whose membership does not intersect any active workstream. */
  topicBacklog?: PanelTopicRow[];
}

/** Fallback codicon id when a topic-type isn't in the type map. */
const FALLBACK_TOPIC_ICON = 'symbol-key';
/** Fallback codicon id for an empty (no topics linked) group header. */
const FALLBACK_GROUP_ICON = 'symbol-keyword';
/** Codicon id for a Blackboard document row. */
const DOCUMENT_ROW_ICON = 'file';
/** Depth guard for topic-tree walks. */
const MAX_TOPIC_DEPTH = 20;
/** Empty topic-type map used when no topic-type icons are supplied. */
const EMPTY_TYPE_MAP: Map<string, TopicType> = new Map();

function iconForType(
  typeId: string,
  typeMap: Map<string, TopicType>,
): string {
  return typeMap.get(typeId)?.icon ?? FALLBACK_TOPIC_ICON;
}

/**
 * Per-topic context-menu actions: add the topic to a workstream, or remove it.
 * With no `workstreamId` the add command prompts a workstream picker.
 */
function topicActions(topicId: string, workstreamId?: string): PanelAction[] {
  const args = {
    topicId,
    ...(workstreamId ? { workstreamId } : {}),
  };
  return [
    {
      command: 'workingMemory.topic.addToWorkstream',
      title: 'Add to workstream',
      args: [args],
    },
    {
      command: 'workingMemory.topic.removeFromWorkstream',
      title: 'Remove from workstream',
      args: [args],
    },
  ];
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
 * Map a workstream status to its Active-tab section. Exact section values pass
 * through; everything else non-closed lands in Progress so nothing silently
 * disappears.
 */
export function sectionForStatus(status: string): WorkstreamSection {
  if (status === 'queue' || status === 'backlog') {
    return status;
  }
  return 'progress';
}

/**
 * Active-tab lifecycle actions for a workstream's context menu. Omits
 * the section the workstream is already in. Each invokes the
 * `working-memory.setWorkstreamSection` command, which patches only the
 * workstream lifecycle status and refreshes the panel.
 */
function sectionMoveActions(ws: { id: string; status: string }): PanelAction[] {
  const current = sectionForStatus(ws.status);
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
      args: [{ id: ws.id, section: t.section }],
      icon:
        orderIndex[t.section] < currentIndex
          ? 'arrow-circle-up'
          : 'arrow-circle-down',
    }));
}

/** An open-alert bubble (count + max severity) sourced from control-plane alerts. */
type ControlPlaneAlertBubble = {
  count: number;
  severity: 'info' | 'warning' | 'error' | null;
};

/**
 * Open-alert bubble for a single control-plane topic. Counts the OPEN alerts
 * (`status !== 'closed'`) whose `topics` refs include `topicId`; severity is
 * the max over those alerts (`alert` > `informational`, else `null` when none).
 */
function controlPlaneTopicAlertBubble(
  alerts: ControlPlaneAlert[],
  topicId: string,
): ControlPlaneAlertBubble {
  return agentMessageBubbleForTopic(alerts, topicId);
}

/**
 * Open-alert bubble rolled up across a workstream's member topic ids. Takes
 * the UNION of open alerts referencing any member topic, DEDUPED by alert `id`;
 * severity is the max over the deduped set (`alert` > `informational`).
 */
function controlPlaneWorkstreamAlertBubble(
  alerts: ControlPlaneAlert[],
  memberTopicIds: string[],
  workstreamId: string,
): ControlPlaneAlertBubble {
  return agentMessageBubbleForTopics(alerts, {

    topicIds: memberTopicIds,
    workstreamIds: [workstreamId],
  });
}

/**
 * One-line description for a control-plane topic row / card entry. Carries the
 * membership count and a non-open status marker (entry rollups are not part of
 * the control-plane model).
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
  parentId: string | null,
  typeMap: Map<string, TopicType>,
  alerts: ControlPlaneAlert[],
): PanelTopicRow {
  const id = t.id ?? '';
  const bubble = controlPlaneTopicAlertBubble(alerts, id);
  return {
    kind: 'topic-row',
    id: `topics:topic:${parentId ?? 'root'}:${id}`,
    label: t.title,
    description: describeControlPlaneTopic(t),
    tooltip: `${t.title} (${id}) — ${t.status}`,
    icon: iconForType(t.topicType, typeMap),
    openUri: `working-memory:/topic/${id}.working-memory`,
    status: t.status,
    recentEntryCount: 0,
    actions: topicActions(id),
    agentMessageCount: bubble.count,
    agentMessageSeverity: bubble.severity,
  };
}

/**
 * Recursively attach control-plane child topics onto a Topics-tab row, walking
 * the parent→children adjacency built from the flat `spec.parents` refs. Guarded
 * by a visited-path set (cycle safety) and {@link MAX_TOPIC_DEPTH}.
 */
function attachControlPlaneChildren(
  row: PanelTopicRow,
  parentId: string,
  childrenById: Map<string, ControlPlaneTopic[]>,
  typeMap: Map<string, TopicType>,
  alerts: ControlPlaneAlert[],
  path: Set<string>,
  depth: number,
): void {
  if (depth >= MAX_TOPIC_DEPTH) {
    return;
  }
  const children = (childrenById.get(parentId) ?? []).filter(
    (c) => (c.id ?? '') !== '' && !path.has(c.id as string),
  );
  if (children.length === 0) {
    return;
  }
  row.children = children.map((c) => {
    const childId = c.id as string;
    const childRow = buildControlPlaneTopicRow(c, parentId, typeMap, alerts);
    const nextPath = new Set(path);
    nextPath.add(childId);
    attachControlPlaneChildren(
      childRow,
      childId,
      childrenById,
      typeMap,
      alerts,
      nextPath,
      depth + 1,
    );
    return childRow;
  });
}

/**
 * Build the Topics tab from the control-plane topic list. Only OPEN topics are
 * shown, rooted at the parentless ones, with the DAG walked top-down via the
 * flat `spec.parents` refs. `available:false` (daemon down) renders the "control plane not running"
 * empty state.
 */
export function buildTopicsPanel(input: {
  available: boolean;
  topics: ControlPlaneTopic[];
  agentMessages?: ControlPlaneAlert[];
  topicTypes?: TopicType[];
  error?: string;
}): PanelData {
  if (!input.available) {
    return { tab: 'topics', items: [], emptyMessage: 'Control plane not running.' };
  }
  const alerts = input.agentMessages ?? [];
  const typeMap = input.topicTypes
    ? new Map(input.topicTypes.map((t) => [t.id, t]))
    : EMPTY_TYPE_MAP;
  const open = input.topics.filter(
    (t) => t.status === 'open' && (t.id ?? '') !== '',
  );
  const childrenById = new Map<string, ControlPlaneTopic[]>();
  for (const t of open) {
    for (const p of t.parents) {
      const arr = childrenById.get(p) ?? [];
      arr.push(t);
      childrenById.set(p, arr);
    }
  }
  const roots = open.filter((t) => t.parents.length === 0);
  const items: PanelItem[] = roots.map((t) => {
    const id = t.id as string;
    const row = buildControlPlaneTopicRow(t, null, typeMap, alerts);
    attachControlPlaneChildren(
      row,
      id,
      childrenById,
      typeMap,
      alerts,
      new Set([id]),
      1,
    );
    return row;
  });
  return { tab: 'topics', items, emptyMessage: 'No open topics.' };
}

/**
 * Build the per-workstream-card "Topics" group from the control-plane topics
 * whose `spec.workstreams` membership includes `wsId`. Nests a member under
 * the first of its `spec.parents` that is ALSO a member. A topic is `focused`
 * when its `spec.focusedWorkstreams` includes `wsId`. Returns the group PLUS
 * the flat membership-ordered `orderedTopics` so the caller can derive the
 * pinned `focused_topics` row.
 */
function buildControlPlaneCardTopics(
  wsId: string,
  tab: 'active' | 'archive',
  members: ControlPlaneTopic[],
  typeMap: Map<string, TopicType>,
  alerts: ControlPlaneAlert[],
): { group: PanelTopicsGroup; orderedTopics: PanelTopic[] } {
  const panelById = new Map<string, PanelTopic>();
  const orderedIds: string[] = [];
  for (const t of members) {
    const id = t.id ?? '';
    if (id === '') {
      continue;
    }
    const bubble = controlPlaneTopicAlertBubble(alerts, id);
    panelById.set(id, {
      kind: 'topic',
      id: `${tab}:topic:${wsId}:${id}`,
      documentId: t.id,
      label: t.title,
      description: describeControlPlaneTopic(t),
      tooltip: `${t.title} (${id}) — ${t.status}`,
      icon: iconForType(t.topicType, typeMap),
      openUri: `working-memory:/topic/${id}.working-memory`,
      status: t.status,
      focused: (t.focusedWorkstreams ?? []).includes(wsId),
      recentEntryCount: 0,
      actions: topicActions(id, wsId),
      agentMessageCount: bubble.count,
      agentMessageSeverity: bubble.severity,
    });
    orderedIds.push(id);
  }
  const idSet = new Set(panelById.keys());
  const childrenById = new Map<string, string[]>();
  const rootIds: string[] = [];
  for (const t of members) {
    const id = t.id ?? '';
    if (id === '' || !idSet.has(id)) {
      continue;
    }
    const inSetParent = t.parents.find((p) => idSet.has(p) && p !== id);
    if (inSetParent) {
      const arr = childrenById.get(inSetParent) ?? [];
      arr.push(id);
      childrenById.set(inSetParent, arr);
    } else {
      rootIds.push(id);
    }
  }
  const attach = (id: string, path: Set<string>, depth: number): void => {
    if (depth >= MAX_TOPIC_DEPTH) {
      return;
    }
    const kids = (childrenById.get(id) ?? []).filter((s) => !path.has(s));
    if (kids.length === 0) {
      return;
    }
    const panel = panelById.get(id);
    if (!panel) {
      return;
    }
    panel.children = kids.map((s) => panelById.get(s) as PanelTopic);
    for (const s of kids) {
      const next = new Set(path);
      next.add(s);
      attach(s, next, depth + 1);
    }
  };
  for (const s of rootIds) {
    attach(s, new Set([s]), 1);
  }
  const children = rootIds.map((s) => panelById.get(s) as PanelTopic);
  const count = orderedIds.length;
  return {
    group: {
      kind: 'topics-group',
      id: `${tab}:topics-group:${wsId}`,
      label: count > 0 ? `Topics (${count})` : 'Topics',
      description: count > 0 ? undefined : 'none linked',
      icon: FALLBACK_GROUP_ICON,
      collapsible: count > 0,
      children,
    },
    orderedTopics: orderedIds.map((s) => panelById.get(s) as PanelTopic),
  };
}

/**
 * The nested tree groups a workstream renders: the "Topics (N)" group (member
 * topics nested by their in-set parents. This is the SHARED
 * composition the left-rail workstream card renders AND the Svelte workstream
 * editor mirrors below its flat topics list — pure, a function of already-
 * fetched control-plane values.
 */
export interface WorkstreamTree {
  /** Topic groups rendered by the rail card. */
  groups: PanelTopicsGroup[];
  /** Member topics flagged `focused` (drives the card's pinned row). */
  focusedTopics: PanelTopic[];
  /** Membership-filtered member topics (for the caller's alert rollup). */
  members: ControlPlaneTopic[];
}

/**
 * Compose a workstream's {@link WorkstreamTree}. Extracted from
 * {@link buildDomainWorkstreamCard} so the rail card and the Svelte workstream
 * editor build the SAME nested topic structure from the same inputs.
 * The full tree retains every member; only open focused topics appear in the
 * pinned strip.
 */
export function buildWorkstreamTree(
  wsId: string,
  tab: 'active' | 'archive',
  topics: ControlPlaneTopic[] | undefined,
  typeMap: Map<string, TopicType>,
  alerts: ControlPlaneAlert[],
): WorkstreamTree {
  const groups: PanelTopicsGroup[] = [];
  const members =
    topics !== undefined && wsId.length > 0
      ? topics.filter((t) => t.workstreams.includes(wsId))
      : [];
  let focusedTopics: PanelTopic[] = [];
  if (topics !== undefined && wsId.length > 0) {
    const { group, orderedTopics } = buildControlPlaneCardTopics(
      wsId,
      tab,
      members,
      typeMap,
      alerts,
    );
    groups.push(group);
    focusedTopics = orderedTopics.filter((t) => t.focused && t.status === 'open');
  }
  return { groups, focusedTopics, members };
}

/**
 * Build an Active/Archive workstream CARD from a control-plane Workstream. The
 * per-workstream "Topics" group is populated from control-plane topic membership
 * (`spec.workstreams`) when `topics` is supplied; absent → the group is omitted.
 * The open-alert bubble is rolled up from the control-plane `alerts` across the
 * card's member topic ids. The per-workstream focused-topic PIN is populated
 * from the control-plane `spec.focusedWorkstreams` subset.
 */
function buildDomainWorkstreamCard(
  ws: Workstream,
  tab: 'active' | 'archive',
  topics: ControlPlaneTopic[] | undefined,
  typeMap: Map<string, TopicType>,
  alerts: ControlPlaneAlert[],
): PanelWorkstream {
  const id = ws.id ?? '';
  const status = ws.status;
  const baseTooltip = `${ws.title} (${id || '∅'}) — ${status}`;
  const tooltip = ws.closure?.trim()
    ? `${baseTooltip}\n\n${ws.closure.trim()}`
    : baseTooltip;
  const description =
    tab === 'archive' && ws.closure?.trim() ? ws.closure.trim() : '';
  const actions: PanelAction[] =
    id.length === 0
      ? []
      : tab === 'archive'
        ? [
            {
              command: 'working-memory.reopenWorkstream',
              title: 'Reopen Workstream',
              args: [{ id }],
            },
          ]
        : [
            ...sectionMoveActions({ id, status }),
            {
              command: 'working-memory.setWorkstreamSection',
              title: 'Close Workstream',
              args: [{ id, section: 'closed' }],
              icon: 'check',
            },
          ];
  const { groups: children, focusedTopics, members } = buildWorkstreamTree(
    ws.id,
    tab,
    topics,
    typeMap,
    alerts,
  );
  const memberIds = members
    .map((t) => t.id ?? '')
    .filter((s) => s !== '');
  const wsBubble = controlPlaneWorkstreamAlertBubble(alerts, memberIds, ws.id);
  return {
    kind: 'workstream',
    id: ws.id,

    label: ws.title,
    description,
    tooltip,
    openUri: `working-memory:/workstream/${encodeURIComponent(ws.id)}.working-memory`,
    recentEntryCount: 0,
    ...(tab === 'active' ? { section: sectionForStatus(status) } : {}),
    agentMessageCount: wsBubble.count,
    agentMessageSeverity: wsBubble.severity,
    actions,
    focused_topics: focusedTopics,
    children,
  };
}

export interface WorkstreamPanels {
  active: PanelData;
  archive: PanelData;
}

/**
 * Build the Active + Archive tabs from the control-plane workstream domain
 * layer. `available:false` (daemon down) renders both tabs with the "control
 * plane not running" empty state; otherwise workstreams are grouped by lifecycle
 * status — queue/progress/backlog → the three Active sections, closed → Archive.
 *
 * When `topics` (from `client.topicRead`) is supplied, each card's "Topics"
 * group is populated from `spec.workstreams` membership; `alerts` (from
 * `client.alertRead`) drive the per-topic and per-workstream open-alert bubbles;
 * `topicTypes` (from `client.topicTypeRead`) drive per-topic icons.
 */
export function buildWorkstreamPanels(input: {
  available: boolean;
  workstreams: Workstream[];
  topics?: ControlPlaneTopic[];
  agentMessages?: ControlPlaneAlert[];
  topicTypes?: TopicType[];
  error?: string;
}): WorkstreamPanels {
  if (!input.available) {
    return {
      active: { tab: 'active', items: [], emptyMessage: 'Control plane not running.' },
      archive: { tab: 'archive', items: [], emptyMessage: 'Control plane not running.' },
    };
  }
  const alerts = input.agentMessages ?? [];
  const typeMap = input.topicTypes
    ? new Map(input.topicTypes.map((t) => [t.id, t]))
    : EMPTY_TYPE_MAP;
  const buckets: Record<WorkstreamSection, PanelWorkstream[]> = {
    queue: [],
    progress: [],
    backlog: [],
  };
  const archived: PanelWorkstream[] = [];
  const orderedWorkstreams = input.workstreams
    .map((workstream, index) => ({ workstream, index }))
    .sort((left, right) =>
      (left.workstream.position ?? 0) - (right.workstream.position ?? 0) || left.index - right.index)
    .map(({ workstream }) => workstream);
  for (const ws of orderedWorkstreams) {
    if (ws.status === 'closed') {
      archived.push(
        buildDomainWorkstreamCard(ws, 'archive', input.topics, typeMap, alerts),
      );
    } else {
      buckets[sectionForStatus(ws.status)].push(
        buildDomainWorkstreamCard(ws, 'active', input.topics, typeMap, alerts),
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
  const activeWorkstreamIds = new Set(
    input.workstreams
      .filter((workstream) => workstream.status !== 'closed' && workstream.id)
      .map((workstream) => workstream.id as string),
  );
  const topicBacklog = (input.topics ?? [])
    .filter((topic) =>
      topic.status === 'open' &&
      topic.id &&
      !topic.workstreams.some((workstream) => activeWorkstreamIds.has(workstream)))
    .map((topic) => buildControlPlaneTopicRow(topic, null, typeMap, alerts))
    .sort((left, right) => left.label.localeCompare(right.label));
  return {
    active: {
      tab: 'active',
      items: activeItems,
      emptyMessage: 'No active workstreams.',
      topicBacklog,
    },
    archive: {
      tab: 'archive',
      items: archived,
      emptyMessage: 'No archived workstreams.',
    },
  };
}

/** Build one Blackboard row from a control-plane document envelope. */
function buildDocumentRow(doc: DocumentEnvelope): PanelDocumentRow {
  const id = doc.metadata.id;
  const idShort = id.slice(0, 8);
  const rv = doc.metadata.resourceVersion;
  return {
    kind: 'document-row',
    id: `blackboard:document:${id}`,
    label: `${doc.kind}: ${id ?? idShort}`,
    description: `v${rv} • ${idShort}`,
    tooltip: `${doc.kind} ${id}${id ? ` (${id})` : ''} — resourceVersion ${rv}`,
    icon: DOCUMENT_ROW_ICON,
    openUri: `working-memory:/document/${encodeURIComponent(id)}.working-memory`,
  };
}

/** History ordering: open, acknowledged, then resolved. */
function alertStatusRank(status: ControlPlaneAlert['status']): number {
  return status === 'open' ? 0 : status === 'acknowledged' ? 1 : 2;
}

/** Build one canonical agent-message row. */
function buildAlertRow(alert: ControlPlaneAlert): PanelAlert {
  const icon =
    alert.status === 'open' && alert.attention
      ? 'bell'
      : alert.status === 'open'
        ? 'info'
        : 'pass';
  const title =
    alert.title.trim() ||
    alert.description.split('\n')[0].trim() ||
    `Agent message ${alert.id.slice(0, 8)}`;
  const next = alert.recommended_action.trim();
  const tooltip =
    [alert.description.trim(), next ? `Next: ${next}` : '']
      .filter(Boolean)
      .join('\n') || title;
  return {
    kind: 'agent-message',
    id: `agent-message:${alert.id}`,
    label: title,
    description: '',
    status: alert.status,
    category: alert.category,
    severity: alert.severity,
    attention: alert.attention,
    icon,
    tooltip,
    openUri: `working-memory:/agent-message/${encodeURIComponent(alert.id)}.working-memory`,
  };
}

/**
 * Build message history, ordered open → acknowledged → resolved, newest-first. The
 * empty state reflects the daemon's reachability.
 */
export function buildAgentMessagesPanel(input: {
  available: boolean;
  agentMessages?: ControlPlaneAlert[];
  error?: string;
}): PanelData {
  if (!input.available) {
    return {
      tab: 'agent-messages',
      items: [],
      emptyMessage: input.error ?? 'Control plane not running.',
    };
  }
  const alerts = (input.agentMessages ?? [])
    .slice()
    .sort(
      (a, b) =>
        alertStatusRank(a.status) - alertStatusRank(b.status) ||
        b.updated_at - a.updated_at,
    );
  return {
    tab: 'agent-messages',
    items: alerts.map(buildAlertRow),
    emptyMessage: 'No agent messages.',
  };
}

/** Build one Topic-Types-tab row from a control-plane topic type. */
function buildTopicTypeRow(tt: TopicType): PanelTopicType {
  const id = tt.id;
  return {
    kind: 'topic-type',
    id: `topic-type:${id}`,
    label: tt.label || id,
    description: id,
    icon: tt.icon || FALLBACK_TOPIC_ICON,
    tooltip: tt.description || tt.label || id,
    openUri: `working-memory:/topic-type/${encodeURIComponent(id)}.working-memory`,
  };
}

/**
 * Build the Topic-Types tab from the control-plane topic-type list, sorted by
 * label. Each row carries the type's own codicon (falling back to the shape
 * icon) and opens its topic-type document. The empty state reflects the
 * daemon's reachability.
 */
export function buildTopicTypesPanel(input: {
  available: boolean;
  topicTypes?: TopicType[];
  error?: string;
}): PanelData {
  if (!input.available) {
    return {
      tab: 'topic-types',
      items: [],
      emptyMessage: input.error ?? 'Control plane not running.',
    };
  }
  const rows = (input.topicTypes ?? [])
    .slice()
    .sort((a, b) =>
      (a.label || a.id || '').localeCompare(b.label || b.id || ''),
    )
    .map(buildTopicTypeRow);
  return {
    tab: 'topic-types',
    items: rows,
    emptyMessage: 'No topic types yet.',
  };
}

/**
 * Build the Blackboard tab from a `wm-document-read` result. Sourced through the
 * control-plane MCP client, so the empty state reflects the daemon's
 * reachability: unavailable → "Control plane not running"; reachable-but-empty →
 * "No documents yet".
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
