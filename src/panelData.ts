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
  Alert as ControlPlaneAlert,
  DocumentEnvelope,
  ListDocumentsResult,
  Nanite,
  NaniteTemplate,
  Topic as ControlPlaneTopic,
  TopicType,
  Workstream,
} from './controlPlaneClient';

/** The three Active-tab lifecycle sections a workstream can live in. */
export type WorkstreamSection = 'queue' | 'progress' | 'backlog';

export type PanelTab =
  | 'active'
  | 'archive'
  | 'topics'
  | 'topic-types'
  | 'alerts'
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
  alertCount?: number;
  /** Max severity among open alerts: 'alert' reddish, 'informational' default. */
  alertSeverity?: 'alert' | 'informational' | null;
  /** Nested child topics (and any nanites nested under this topic) — only set when non-empty. */
  children?: Array<PanelTopic | PanelNaniteRow>;
}

export interface PanelTopicsGroup {
  kind: 'topics-group';
  id: string;
  label: string;
  description?: string;
  /** Codicon id for the group header. */
  icon: string;
  collapsible: boolean;
  children: Array<PanelTopic | PanelNaniteRow>;
}

export interface PanelWorkstream {
  kind: 'workstream';
  id: string;
  /** The workstream's stable slug (null when it has none). */
  slug: string | null;
  label: string;
  description: string;
  tooltip: string;
  openUri: string;
  recentEntryCount: number;
  /** Active-tab section this workstream currently lives in. */
  section?: WorkstreamSection;
  /** Open-alert count aggregated across the workstream's linked topics; 0 hides the bubble. */
  alertCount?: number;
  /** Max severity among open alerts: 'alert' reddish, 'informational' default. */
  alertSeverity?: 'alert' | 'informational' | null;
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
  alertCount?: number;
  alertSeverity?: 'alert' | 'informational' | null;
  children?: Array<PanelTopicRow | PanelNaniteRow>;
}

/**
 * A Nanite row rendered as a CHILD of its input topic in the panel tree (kind
 * `nanite`, so `media/panel/panel.js` renders it with right-click actions and
 * deleted-muting). One Nanite = one execution instance of a Nanite Template; it
 * shows its lifecycle `phase` (Pending → Running → Succeeded|Failed) and offers
 * a Run action while Pending.
 */
export interface PanelNaniteRow {
  kind: 'nanite';
  id: string;
  /** The bare nanite document id (its agent id), used to open the agent chat. */
  naniteId: string;
  label: string;
  description: string;
  tooltip: string;
  /** Codicon id. */
  icon: string;
  /** `working-memory:/document/<id>.working-memory` unified-editor URI (generic envelope route). */
  openUri: string;
  /** Lifecycle phase. */
  phase: 'Pending' | 'Queued' | 'Running' | 'Succeeded' | 'Failed';
  /** Owning Nanite Template ref (id or slug); used to filter on the Nanites tab. */
  templateId: string | null;
  /** Whether the underlying document is soft-deleted (muted in the tree). */
  deleted: boolean;
  actions?: PanelAction[];
}

/**
 * A Nanite Template row for the top section of the Nanites tab. Clicking it
 * selects/filters the nanites list below; `templateId`/`slug` are the match keys.
 */
export interface PanelNaniteTemplateRow {
  kind: 'nanite-template';
  /** DOM id. */
  id: string;
  /** Template document id (primary selection key). */
  templateId: string;
  /** Template slug (secondary selection key). */
  slug: string | null;
  label: string;
  description: string;
  tooltip: string;
  icon: string;
  openUri: string;
  enabled: boolean;
}

/**
 * The Nanites tab payload: templates on top, latest nanites (newest-first)
 * below, split by a draggable divider in the webview. Distinct from `PanelData`
 * (no flat `items`) — the webview renders it with a dedicated split view.
 */
export interface PanelNanitesData {
  tab: 'nanites';
  available: boolean;
  templates: PanelNaniteTemplateRow[];
  nanites: PanelNaniteRow[];
  emptyMessage: string;
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
  | PanelAlert
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
  /** `working-memory:/topic-type/<slug>.working-memory` unified-editor URI. */
  openUri: string;
}

/** An Alerts-tab row: one control-plane alert rendered as a flat, clickable row. */
export interface PanelAlert {
  kind: 'alert';
  id: string;
  label: string;
  description: string;
  /** Authored lifecycle status; drives the row's severity styling. */
  status: 'alert' | 'informational' | 'closed';
  /** Codicon id. */
  icon: string;
  tooltip: string;
  /** `working-memory:/alert/<id>.working-memory` unified-editor URI. */
  openUri: string;
}

export interface PanelData {
  tab: PanelTab;
  items: PanelItem[];
  emptyMessage: string;
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
 * With no `workstreamSlug` the add command prompts a workstream picker.
 */
function topicActions(topicSlug: string, workstreamSlug?: string): PanelAction[] {
  const args = {
    topicSlug,
    ...(workstreamSlug ? { workstreamSlug } : {}),
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
 * Active-tab "send to section" actions for a workstream's context menu. Omits
 * the section the workstream is already in. Each invokes the
 * `working-memory.setWorkstreamSection` command (registered in extension.ts),
 * which patches the lifecycle `status` via the control-plane workstream domain
 * layer and refreshes the panel.
 */
function sectionMoveActions(ws: { slug: string; status: string }): PanelAction[] {
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
      args: [{ slug: ws.slug, section: t.section }],
      icon:
        orderIndex[t.section] < currentIndex
          ? 'arrow-circle-up'
          : 'arrow-circle-down',
    }));
}

/** An open-alert bubble (count + max severity) sourced from control-plane alerts. */
type ControlPlaneAlertBubble = {
  count: number;
  severity: 'alert' | 'informational' | null;
};

/**
 * Open-alert bubble for a single control-plane topic. Counts the OPEN alerts
 * (`status !== 'closed'`) whose `topics` refs include `topicSlug`; severity is
 * the max over those alerts (`alert` > `informational`, else `null` when none).
 */
function controlPlaneTopicAlertBubble(
  alerts: ControlPlaneAlert[],
  topicSlug: string,
): ControlPlaneAlertBubble {
  let count = 0;
  let hasAlert = false;
  let hasInformational = false;
  for (const a of alerts) {
    if (a.status === 'closed' || !a.topics.includes(topicSlug)) {
      continue;
    }
    count += 1;
    if (a.status === 'alert') {
      hasAlert = true;
    } else if (a.status === 'informational') {
      hasInformational = true;
    }
  }
  return {
    count,
    severity: hasAlert ? 'alert' : hasInformational ? 'informational' : null,
  };
}

/**
 * Open-alert bubble rolled up across a workstream's member topic slugs. Takes
 * the UNION of open alerts referencing any member topic, DEDUPED by alert `id`;
 * severity is the max over the deduped set (`alert` > `informational`).
 */
function controlPlaneWorkstreamAlertBubble(
  alerts: ControlPlaneAlert[],
  memberTopicSlugs: string[],
): ControlPlaneAlertBubble {
  const members = new Set(memberTopicSlugs);
  const seen = new Set<string>();
  let count = 0;
  let hasAlert = false;
  let hasInformational = false;
  for (const a of alerts) {
    if (a.status === 'closed' || seen.has(a.id)) {
      continue;
    }
    if (!a.topics.some((t) => members.has(t))) {
      continue;
    }
    seen.add(a.id);
    count += 1;
    if (a.status === 'alert') {
      hasAlert = true;
    } else if (a.status === 'informational') {
      hasInformational = true;
    }
  }
  return {
    count,
    severity: hasAlert ? 'alert' : hasInformational ? 'informational' : null,
  };
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
  parentSlug: string | null,
  typeMap: Map<string, TopicType>,
  alerts: ControlPlaneAlert[],
): PanelTopicRow {
  const slug = t.slug ?? '';
  const bubble = controlPlaneTopicAlertBubble(alerts, slug);
  return {
    kind: 'topic-row',
    id: `topics:topic:${parentSlug ?? 'root'}:${slug}`,
    label: t.title,
    description: describeControlPlaneTopic(t),
    tooltip: `${t.title} (${slug}) — ${t.status}`,
    icon: iconForType(t.topicType, typeMap),
    openUri: `working-memory:/topic/${slug}.working-memory`,
    status: t.status,
    recentEntryCount: 0,
    actions: topicActions(slug),
    alertCount: bubble.count,
    alertSeverity: bubble.severity,
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
  alerts: ControlPlaneAlert[],
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
    const childRow = buildControlPlaneTopicRow(c, parentSlug, typeMap, alerts);
    const nextPath = new Set(path);
    nextPath.add(childSlug);
    attachControlPlaneChildren(
      childRow,
      childSlug,
      childrenBySlug,
      typeMap,
      alerts,
      nextPath,
      depth + 1,
    );
    return childRow;
  });
}

/**
 * Build a Nanite child row for the Topics tab. A Nanite renders under its input
 * topic showing its lifecycle `phase`; while `Pending` it offers a Run action
 * (the `workingMemory.nanite.run` command, registered in extension.ts). Kind
 * `nanite` so `media/panel/panel.js` gives it right-click actions + soft-delete
 * muting.
 */
function buildNaniteRow(
  n: Nanite,
  rowIdPrefix = `topics:nanite:${n.inputTopic}`,
  labelOverride?: string,
): PanelNaniteRow {
  const label =
    labelOverride ?? (n.request.trim() || n.templateId || `Nanite ${n.id.slice(0, 8)}`);
  const runAction: PanelAction = {
    command: 'workingMemory.nanite.run',
    title: 'Approve & Run',
    icon: 'play',
    args: [{ id: n.id }],
  };
  const resetAction: PanelAction = {
    command: 'workingMemory.nanite.reset',
    title: 'Reset to Pending',
    icon: 'discard',
    args: [{ id: n.id }],
  };
  const restartAction: PanelAction = {
    command: 'workingMemory.nanite.restart',
    title: 'Restart Nanite',
    icon: 'debug-restart',
    args: [{ id: n.id }],
  };
  // Actions per lifecycle phase: Pending offers Run; Queued/Running offer a
  // Cancel (reset to Pending); terminal offers Restart + Reset.
  const actions: PanelAction[] =
    n.phase === 'Pending'
      ? [runAction]
      : n.phase === 'Queued' || n.phase === 'Running'
        ? [{ ...resetAction, title: 'Cancel (Reset to Pending)' }]
        : [restartAction, resetAction];
  // At-a-glance status hover so a reader can tell what (if anything) a phase
  // is waiting on — Pending especially reads as "waiting for you to Run it".
  const phaseHint = NANITE_PHASE_HINT[n.phase];
  return {
    kind: 'nanite',
    id: `${rowIdPrefix}:${n.id}`,
    naniteId: n.id,
    label,
    description: n.phase,
    tooltip: `${label} — ${n.phase}${phaseHint ? `\n${phaseHint}` : ''}`,
    icon: NANITE_PHASE_ICON[n.phase],
    // Generic envelope route — the unified editor's generic DocumentView.
    openUri: `working-memory:/document/${n.id}.working-memory`,
    phase: n.phase,
    templateId: n.templateId,
    deleted: false,
    actions,
  };
}

/** One-line "what is this waiting on" hint per phase (panel row tooltip). */
const NANITE_PHASE_HINT: Record<Nanite['phase'], string> = {
  Pending: 'Waiting for approval — it will not run on its own; press Run to approve & queue it.',
  Queued: 'Queued — the dispatcher will start it automatically.',
  Running: 'Running now.',
  Succeeded: 'Finished — succeeded.',
  Failed: 'Finished — failed; open it for the error.',
};

/** Codicon per Nanite lifecycle phase. */
const NANITE_PHASE_ICON: Record<Nanite['phase'], string> = {
  Pending: 'circle-outline',
  Queued: 'clock',
  Running: 'sync',
  Succeeded: 'pass',
  Failed: 'error',
};

/** Format a unix-seconds timestamp for a nanite card row. */
function formatNaniteTimestamp(sec: number): string {
  return new Date(sec * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Map a Nanite Template ref (id or slug) → friendly title. */
function naniteTemplateNameMap(templates: NaniteTemplate[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of templates) {
    m.set(t.id, t.title);
    if (t.slug) {
      m.set(t.slug, t.title);
    }
  }
  return m;
}

/** Card row label for a nanite: its template's friendly name + timestamp. */
function cardNaniteLabel(n: Nanite, nameByRef: Map<string, string>): string {
  const tname = n.templateId ? nameByRef.get(n.templateId) : undefined;
  const base = tname ?? (n.request.trim() || `Nanite ${n.id.slice(0, 8)}`);
  return `${base} · ${formatNaniteTimestamp(n.created_at)}`;
}

/**
 * Build the per-card "Nanites" group. `nanites` is assumed pre-filtered to the
 * workstream's ORPHAN nanites (those whose input topic is NOT a member of the
 * card — nanites whose topic IS a member nest under that topic instead). Newest
 * first, labelled with the Nanite Template's friendly name + timestamp. Returns
 * null when empty.
 */
function buildWorkstreamNanitesGroup(
  wsId: string,
  tab: 'active' | 'archive',
  nanites: Nanite[],
  templates: NaniteTemplate[],
): PanelTopicsGroup | null {
  if (nanites.length === 0) {
    return null;
  }
  const nameByRef = naniteTemplateNameMap(templates);
  const rows = [...nanites]
    .sort((a, b) => b.created_at - a.created_at)
    .map((n) =>
      buildNaniteRow(n, `${tab}:ws-nanite:${wsId}`, cardNaniteLabel(n, nameByRef)),
    );
  return {
    kind: 'topics-group',
    id: `${tab}:ws-nanites:${wsId}`,
    label: `Nanites (${rows.length})`,
    icon: 'zap',
    collapsible: true,
    children: rows,
  };
}

/** Build a top-section row for a Nanite Template on the Nanites tab. */
function buildNaniteTemplateRow(t: NaniteTemplate): PanelNaniteTemplateRow {
  return {
    kind: 'nanite-template',
    id: `nanites:template:${t.id}`,
    templateId: t.id,
    slug: t.slug,
    label: t.title,
    description: t.enabled ? '' : 'disabled',
    tooltip: `${t.title}${t.slug ? ` (${t.slug})` : ''}`,
    icon: t.enabled ? 'symbol-class' : 'circle-slash',
    openUri: `working-memory:/document/${t.id}.working-memory`,
    enabled: t.enabled,
  };
}

/**
 * Build the Nanites tab: Nanite Templates on top, latest Nanites (newest-first)
 * below. The webview splits them with a draggable divider and filters the
 * bottom list to the selected template. `available:false` renders the empty
 * "control plane not running" state.
 */
export function buildNanitesPanel(input: {
  available: boolean;
  templates?: NaniteTemplate[];
  nanites?: Nanite[];
}): PanelNanitesData {
  if (!input.available) {
    return {
      tab: 'nanites',
      available: false,
      templates: [],
      nanites: [],
      emptyMessage: 'Control plane not running.',
    };
  }
  const templates = (input.templates ?? []).map(buildNaniteTemplateRow);
  const nanites = [...(input.nanites ?? [])]
    .sort((a, b) => b.created_at - a.created_at)
    .map((n) => buildNaniteRow(n, 'nanites:nanite'));
  return {
    tab: 'nanites',
    available: true,
    templates,
    nanites,
    emptyMessage: 'No nanite templates yet.',
  };
}

/** Slug of a topic row, parsed from its `working-memory:/topic/<slug>.working-memory` openUri. */
function topicSlugFromRow(row: PanelTopicRow): string | null {
  const m = /^working-memory:\/topic\/(.+)\.working-memory$/.exec(row.openUri);
  return m ? m[1] : null;
}

/**
 * Recursively append Nanite child rows onto every topic row whose slug is an
 * input topic in `nanitesByTopic`. Nanites are appended AFTER any child topics,
 * and the walk descends only into topic-row children (never into nanite rows).
 */
function attachNanites(
  row: PanelTopicRow,
  nanitesByTopic: Map<string, PanelNaniteRow[]>,
): void {
  const existing = row.children ?? [];
  for (const child of existing) {
    if (child.kind === 'topic-row') {
      attachNanites(child, nanitesByTopic);
    }
  }
  const slug = topicSlugFromRow(row);
  const nanites = slug ? nanitesByTopic.get(slug) : undefined;
  if (nanites && nanites.length > 0) {
    row.children = [...existing, ...nanites];
  }
}

/**
 * Build the Topics tab from the control-plane topic list. Only OPEN topics are
 * shown, rooted at the parentless ones, with the DAG walked top-down via the
 * flat `spec.parents` refs. Nanites render as child rows under their input
 * topic. `available:false` (daemon down) renders the "control plane not running"
 * empty state.
 */
export function buildTopicsPanel(input: {
  available: boolean;
  topics: ControlPlaneTopic[];
  nanites?: Nanite[];
  alerts?: ControlPlaneAlert[];
  topicTypes?: TopicType[];
  error?: string;
}): PanelData {
  if (!input.available) {
    return { tab: 'topics', items: [], emptyMessage: 'Control plane not running.' };
  }
  const alerts = input.alerts ?? [];
  const typeMap = input.topicTypes
    ? new Map(input.topicTypes.map((t) => [t.slug ?? t.id, t]))
    : EMPTY_TYPE_MAP;
  const open = input.topics.filter(
    (t) => t.status === 'open' && (t.slug ?? '') !== '',
  );
  const childrenBySlug = new Map<string, ControlPlaneTopic[]>();
  for (const t of open) {
    for (const p of t.parents) {
      const arr = childrenBySlug.get(p) ?? [];
      arr.push(t);
      childrenBySlug.set(p, arr);
    }
  }
  // Group nanites by their input topic slug for under-topic render (the read
  // returns non-deleted rows only).
  const nanitesByTopic = new Map<string, PanelNaniteRow[]>();
  for (const n of input.nanites ?? []) {
    const arr = nanitesByTopic.get(n.inputTopic) ?? [];
    arr.push(buildNaniteRow(n));
    nanitesByTopic.set(n.inputTopic, arr);
  }
  const roots = open.filter((t) => t.parents.length === 0);
  const items: PanelItem[] = roots.map((t) => {
    const slug = t.slug as string;
    const row = buildControlPlaneTopicRow(t, null, typeMap, alerts);
    attachControlPlaneChildren(
      row,
      slug,
      childrenBySlug,
      typeMap,
      alerts,
      new Set([slug]),
      1,
    );
    attachNanites(row, nanitesByTopic);
    return row;
  });
  return { tab: 'topics', items, emptyMessage: 'No open topics.' };
}

/**
 * Build the per-workstream-card "Topics" group from the control-plane topics
 * whose `spec.workstreams` membership includes `wsSlug`. Nests a member under
 * the first of its `spec.parents` that is ALSO a member. A topic is `focused`
 * when its `spec.focusedWorkstreams` includes `wsSlug`. Returns the group PLUS
 * the flat membership-ordered `orderedTopics` so the caller can derive the
 * pinned `focused_topics` row.
 */
function buildControlPlaneCardTopics(
  wsSlug: string,
  wsId: string,
  tab: 'active' | 'archive',
  members: ControlPlaneTopic[],
  typeMap: Map<string, TopicType>,
  alerts: ControlPlaneAlert[],
  nanites: Nanite[] = [],
  naniteTemplates: NaniteTemplate[] = [],
): { group: PanelTopicsGroup; orderedTopics: PanelTopic[] } {
  const panelBySlug = new Map<string, PanelTopic>();
  const orderedSlugs: string[] = [];
  for (const t of members) {
    const slug = t.slug ?? '';
    if (slug === '') {
      continue;
    }
    const bubble = controlPlaneTopicAlertBubble(alerts, slug);
    panelBySlug.set(slug, {
      kind: 'topic',
      id: `${tab}:topic:${wsId}:${slug}`,
      label: t.title,
      description: describeControlPlaneTopic(t),
      tooltip: `${t.title} (${slug}) — ${t.status}`,
      icon: iconForType(t.topicType, typeMap),
      openUri: `working-memory:/topic/${slug}.working-memory`,
      status: t.status,
      focused: (t.focusedWorkstreams ?? []).includes(wsSlug),
      recentEntryCount: 0,
      actions: topicActions(slug, wsSlug),
      alertCount: bubble.count,
      alertSeverity: bubble.severity,
    });
    orderedSlugs.push(slug);
  }
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
  // Nest nanites under their input topic (`nanites` is pre-filtered to members
  // of this workstream). Appended after any child topics on the same panel.
  if (nanites.length > 0) {
    const nameByRef = naniteTemplateNameMap(naniteTemplates);
    for (const n of [...nanites].sort((a, b) => b.created_at - a.created_at)) {
      const panel = panelBySlug.get(n.inputTopic);
      if (!panel) {
        continue;
      }
      const row = buildNaniteRow(
        n,
        `${tab}:topic-nanite:${wsId}:${n.inputTopic}`,
        cardNaniteLabel(n, nameByRef),
      );
      panel.children = [...(panel.children ?? []), row];
    }
  }
  const children = rootSlugs.map((s) => panelBySlug.get(s) as PanelTopic);
  const count = orderedSlugs.length;
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
    orderedTopics: orderedSlugs.map((s) => panelBySlug.get(s) as PanelTopic),
  };
}

/**
 * The nested tree groups a workstream renders: the "Topics (N)" group (member
 * topics nested by their in-set parents, each carrying its nanite runs) plus a
 * top-level "Nanites (N)" group of orphan nanites. This is the SHARED
 * composition the left-rail workstream card renders AND the Svelte workstream
 * editor mirrors below its flat topics list — pure, a function of already-
 * fetched control-plane values.
 */
export interface WorkstreamTree {
  /** [Topics group, Nanites group?] — same order the rail card renders. */
  groups: PanelTopicsGroup[];
  /** Member topics flagged `focused` (drives the card's pinned row). */
  focusedTopics: PanelTopic[];
  /** Membership-filtered member topics (for the caller's alert rollup). */
  members: ControlPlaneTopic[];
}

/**
 * Compose a workstream's {@link WorkstreamTree}. Extracted from
 * {@link buildDomainWorkstreamCard} so the rail card and the Svelte workstream
 * editor build the SAME nested topic/nanite structure from the same inputs.
 */
export function buildWorkstreamTree(
  wsId: string,
  wsSlug: string,
  tab: 'active' | 'archive',
  topics: ControlPlaneTopic[] | undefined,
  typeMap: Map<string, TopicType>,
  alerts: ControlPlaneAlert[],
  nanites: Nanite[] = [],
  naniteTemplates: NaniteTemplate[] = [],
): WorkstreamTree {
  const groups: PanelTopicsGroup[] = [];
  const members =
    topics !== undefined && wsSlug.length > 0
      ? topics.filter((t) => t.workstreams.includes(wsSlug))
      : [];
  const memberTopicSlugs = new Set(
    members.map((m) => m.slug ?? '').filter((s) => s !== ''),
  );
  const myNanites =
    wsSlug.length > 0 ? nanites.filter((n) => n.workstream === wsSlug) : [];
  // A nanite whose input topic is a member of this workstream nests under that
  // topic; the rest surface in the top-level "Nanites" group.
  const nestedNanites = myNanites.filter((n) => memberTopicSlugs.has(n.inputTopic));
  const orphanNanites = myNanites.filter((n) => !memberTopicSlugs.has(n.inputTopic));
  let focusedTopics: PanelTopic[] = [];
  if (topics !== undefined && wsSlug.length > 0) {
    const { group, orderedTopics } = buildControlPlaneCardTopics(
      wsSlug,
      wsId,
      tab,
      members,
      typeMap,
      alerts,
      nestedNanites,
      naniteTemplates,
    );
    groups.push(group);
    focusedTopics = orderedTopics.filter((t) => t.focused);
  }
  const nanitesGroup = buildWorkstreamNanitesGroup(
    wsId,
    tab,
    orphanNanites,
    naniteTemplates,
  );
  if (nanitesGroup) {
    groups.push(nanitesGroup);
  }
  return { groups, focusedTopics, members };
}

/**
 * Build an Active/Archive workstream CARD from a control-plane Workstream. The
 * per-workstream "Topics" group is populated from control-plane topic membership
 * (`spec.workstreams`) when `topics` is supplied; absent → the group is omitted.
 * The open-alert bubble is rolled up from the control-plane `alerts` across the
 * card's member topic slugs. The per-workstream focused-topic PIN is populated
 * from the control-plane `spec.focusedWorkstreams` subset.
 */
function buildDomainWorkstreamCard(
  ws: Workstream,
  tab: 'active' | 'archive',
  topics: ControlPlaneTopic[] | undefined,
  typeMap: Map<string, TopicType>,
  alerts: ControlPlaneAlert[],
  nanites: Nanite[] = [],
  naniteTemplates: NaniteTemplate[] = [],
): PanelWorkstream {
  const slug = ws.slug ?? '';
  const status = ws.status;
  const baseTooltip = `${ws.title} (${slug || '∅'}) — ${status}`;
  const tooltip = ws.closure?.trim()
    ? `${baseTooltip}\n\n${ws.closure.trim()}`
    : baseTooltip;
  const description =
    tab === 'archive' && ws.closure?.trim() ? ws.closure.trim() : '';
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
  const { groups: children, focusedTopics, members } = buildWorkstreamTree(
    ws.id,
    slug,
    tab,
    topics,
    typeMap,
    alerts,
    nanites,
    naniteTemplates,
  );
  const memberSlugs = members
    .map((t) => t.slug ?? '')
    .filter((s) => s !== '');
  const wsBubble = controlPlaneWorkstreamAlertBubble(alerts, memberSlugs);
  return {
    kind: 'workstream',
    id: `${tab}:workstream:${ws.id}`,
    slug: ws.slug ?? null,
    label: ws.title,
    description,
    tooltip,
    openUri: `working-memory:/workstream/${encodeURIComponent(ws.slug ?? ws.id)}.working-memory`,
    recentEntryCount: 0,
    ...(tab === 'active' ? { section: sectionForStatus(status) } : {}),
    alertCount: wsBubble.count,
    alertSeverity: wsBubble.severity,
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
  alerts?: ControlPlaneAlert[];
  topicTypes?: TopicType[];
  nanites?: Nanite[];
  naniteTemplates?: NaniteTemplate[];
  error?: string;
}): WorkstreamPanels {
  if (!input.available) {
    return {
      active: { tab: 'active', items: [], emptyMessage: 'Control plane not running.' },
      archive: { tab: 'archive', items: [], emptyMessage: 'Control plane not running.' },
    };
  }
  const alerts = input.alerts ?? [];
  const typeMap = input.topicTypes
    ? new Map(input.topicTypes.map((t) => [t.slug ?? t.id, t]))
    : EMPTY_TYPE_MAP;
  const buckets: Record<WorkstreamSection, PanelWorkstream[]> = {
    queue: [],
    progress: [],
    backlog: [],
  };
  const archived: PanelWorkstream[] = [];
  const nanites = input.nanites ?? [];
  const naniteTemplates = input.naniteTemplates ?? [];
  for (const ws of input.workstreams) {
    if (ws.status === 'closed') {
      archived.push(
        buildDomainWorkstreamCard(ws, 'archive', input.topics, typeMap, alerts, nanites, naniteTemplates),
      );
    } else {
      buckets[sectionForStatus(ws.status)].push(
        buildDomainWorkstreamCard(ws, 'active', input.topics, typeMap, alerts, nanites, naniteTemplates),
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
    openUri: `working-memory:/document/${encodeURIComponent(id)}.working-memory`,
  };
}

/** Status ordering for the Alerts tab: active first, closed last. */
function alertStatusRank(status: ControlPlaneAlert['status']): number {
  return status === 'alert' ? 0 : status === 'informational' ? 1 : 2;
}

/** Build one Alerts-tab row from a control-plane alert. */
function buildAlertRow(alert: ControlPlaneAlert): PanelAlert {
  const icon =
    alert.status === 'alert'
      ? 'bell'
      : alert.status === 'informational'
        ? 'info'
        : 'pass';
  const title =
    alert.title.trim() ||
    alert.description.split('\n')[0].trim() ||
    `Alert ${alert.id.slice(0, 8)}`;
  const next = alert.recommended_action.trim();
  const tooltip =
    [alert.description.trim(), next ? `Next: ${next}` : '']
      .filter(Boolean)
      .join('\n') || title;
  return {
    kind: 'alert',
    id: `alert:${alert.id}`,
    label: title,
    description: '',
    status: alert.status,
    icon,
    tooltip,
    openUri: `working-memory:/alert/${encodeURIComponent(alert.id)}.working-memory`,
  };
}

/**
 * Build the Alerts tab from the control-plane alert list. Rows are ordered
 * active-first (`alert` -> `informational` -> `closed`), then newest-first. The
 * empty state reflects the daemon's reachability.
 */
export function buildAlertsPanel(input: {
  available: boolean;
  alerts?: ControlPlaneAlert[];
  error?: string;
}): PanelData {
  if (!input.available) {
    return {
      tab: 'alerts',
      items: [],
      emptyMessage: input.error ?? 'Control plane not running.',
    };
  }
  const alerts = (input.alerts ?? [])
    .slice()
    .sort(
      (a, b) =>
        alertStatusRank(a.status) - alertStatusRank(b.status) ||
        b.updated_at - a.updated_at,
    );
  return {
    tab: 'alerts',
    items: alerts.map(buildAlertRow),
    emptyMessage: 'No alerts.',
  };
}

/** Build one Topic-Types-tab row from a control-plane topic type. */
function buildTopicTypeRow(tt: TopicType): PanelTopicType {
  const slug = tt.slug ?? tt.id;
  return {
    kind: 'topic-type',
    id: `topic-type:${slug}`,
    label: tt.label || slug,
    description: slug,
    icon: tt.icon || FALLBACK_TOPIC_ICON,
    tooltip: tt.description || tt.label || slug,
    openUri: `working-memory:/topic-type/${encodeURIComponent(slug)}.working-memory`,
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
      (a.label || a.slug || '').localeCompare(b.label || b.slug || ''),
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
