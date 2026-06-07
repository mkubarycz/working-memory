import {
  listTopicsForWorkstream,
  listWorkstreams,
  type WorkstreamTopicRow,
  type WorkstreamWithCount,
} from './db';

/**
 * Plain-JSON shapes shipped to the webview. Keep these serializable —
 * nothing in here may reference `vscode.*` types or DB row objects directly.
 */
export type PanelTab = 'active' | 'archive';

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
  icon: 'symbol-key';
  openUri: string;
}

export interface PanelTopicsGroup {
  kind: 'topics-group';
  id: string;
  label: string;
  description?: string;
  icon: 'symbol-keyword';
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

export interface PanelData {
  tab: PanelTab;
  workstreams: PanelWorkstream[];
  emptyMessage: string;
}

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

function buildTopics(
  tab: PanelTab,
  ws: WorkstreamWithCount,
): PanelTopicsGroup {
  const topics = listTopicsForWorkstream(ws.id);
  const children: PanelTopic[] = topics.map((t) => ({
    kind: 'topic',
    id: `${tab}:topic:${ws.id}:${t.slug}`,
    label: t.title,
    description: describeTopic(t),
    tooltip: `${t.title} (${t.slug}) — ${t.status}`,
    icon: 'symbol-key',
    openUri: `working-memory:/topic/${t.slug}.md`,
  }));
  return {
    kind: 'topics-group',
    id: `${tab}:topics-group:${ws.id}`,
    label: topics.length > 0 ? `Topics (${topics.length})` : 'Topics',
    description: topics.length > 0 ? undefined : 'none linked',
    icon: 'symbol-keyword',
    collapsible: topics.length > 0,
    children,
  };
}

function buildWorkstream(
  tab: PanelTab,
  ws: WorkstreamWithCount,
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
    children: [buildTopics(tab, ws)],
  };
}

export function getPanelData(tab: PanelTab): PanelData {
  const rows =
    tab === 'active'
      ? listWorkstreams({ status: 'open', orderBy: 'last-activity-desc' })
      : listWorkstreams({ status: 'closed', orderBy: 'closed-desc' });
  return {
    tab,
    workstreams: rows.map((w) => buildWorkstream(tab, w)),
    emptyMessage:
      tab === 'active'
        ? 'No active workstreams.'
        : 'No archived workstreams.',
  };
}

export function getAllPanelData(): { active: PanelData; archive: PanelData } {
  return {
    active: getPanelData('active'),
    archive: getPanelData('archive'),
  };
}
