import type {
  AgentMessage,
  ControlPlaneClient,
  Topic,
  TopicType,
  Workstream,
} from '../controlPlaneClient';
import {
  buildWorkstreamTree,
  type PanelAction,
  type PanelTopic,
  type PanelTopicsGroup,
} from '../panelData';
import { buildAgentMessageVMs, type AgentMessageVM } from './agentMessageVms';

export interface WorkstreamViewModel {
  kind: 'workstream';
  id: string;
  title: string;
  slug: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  closure: string | null;
  resourceVersion: number;
  editable: boolean;
  topics: Array<{ id: string; title: string; slug: string; status: string; pinned: boolean }>;
  tree: WorkstreamTreeGroupViewModel[];
  agentMessages: AgentMessageVM[];
}

export interface WorkstreamTreeActionViewModel {
  command: string;
  title: string;
  icon: string;
  args: unknown[];
  enabled: boolean;
}

export interface WorkstreamTreeTopicViewModel {
  kind: 'topic';
  id: string;
  documentId?: string;
  label: string;
  icon: string;
  status: string;
  slug: string;
  pinned: boolean;
  agentMessageCount: number;
  agentMessageSeverity: 'info' | 'warning' | 'error' | null;
  children: WorkstreamTreeTopicViewModel[];
  actions: WorkstreamTreeActionViewModel[];
}

export interface WorkstreamTreeGroupViewModel {
  kind: 'group';
  id: string;
  label: string;
  icon: string;
  children: WorkstreamTreeTopicViewModel[];
}

function treeActions(actions: PanelAction[] | undefined): WorkstreamTreeActionViewModel[] {
  return (actions ?? []).map((action) => ({
    command: action.command,
    title: action.title,
    icon: action.icon ?? '',
    args: Array.isArray(action.args) ? action.args : [],
    enabled: action.enabled !== false,
  }));
}

function topicSlugFromUri(uri: string): string {
  const match = uri.match(/\/topic\/([^/]+)\.working-memory$/);
  return match ? decodeURIComponent(match[1]) : '';
}

function treeNode(row: PanelTopic): WorkstreamTreeTopicViewModel {
  return {
    kind: 'topic',
    id: row.id,
    documentId: row.documentId,
    label: row.label,
    icon: row.icon,
    status: row.status,
    slug: topicSlugFromUri(row.openUri),
    pinned: row.focused,
    agentMessageCount: row.agentMessageCount ?? 0,
    agentMessageSeverity: row.agentMessageSeverity ?? null,
    children: (row.children ?? []).map(treeNode),
    actions: treeActions(row.actions),
  };
}

function treeGroup(group: PanelTopicsGroup): WorkstreamTreeGroupViewModel {
  return {
    kind: 'group',
    id: group.id,
    label: group.label,
    icon: group.icon,
    children: group.children.map(treeNode),
  };
}

export async function readWorkstream(
  client: ControlPlaneClient,
  identifier: string,
): Promise<Workstream | null> {
  const bySlug = await client.wsRead({ slug: identifier });
  if (bySlug[0]) return bySlug[0];
  const byId = await client.wsRead({ id: identifier });
  return byId[0] ?? null;
}

export async function loadWorkstreamViewModel(
  client: ControlPlaneClient,
  identifier: string,
  now = Date.now(),
): Promise<WorkstreamViewModel | null> {
  const workstream = await readWorkstream(client, identifier);
  if (!workstream) return null;

  const slug = workstream.slug;
  let topics: Topic[] = [];
  let topicTypes: TopicType[] = [];
  let agentMessages: AgentMessage[] = [];
  if (slug) {
    [topics, topicTypes] = await Promise.all([
      client.topicRead({ workstream: slug }).catch(() => []),
      client.topicTypeRead().catch(() => []),
    ]);
  }
  agentMessages = await client.agentMessageRead();

  const rows = topics
    .map((topic) => ({
      id: topic.id,
      title: topic.title,
      slug: topic.slug ?? topic.id,
      status: topic.status,
      pinned: slug ? topic.focusedWorkstreams.includes(slug) : false,
    }))
    .sort((left, right) => left.title.localeCompare(right.title));
  const ordered = [...rows.filter((row) => row.pinned), ...rows.filter((row) => !row.pinned)];
  const typeMap = new Map(topicTypes.map((type) => [type.slug ?? type.id, type]));
  const { groups } = buildWorkstreamTree(
    workstream.id,
    slug ?? '',
    'active',
    slug ? topics : undefined,
    typeMap,
    agentMessages,
  );
  const memberSlugs = topics
    .map((topic) => topic.slug)
    .filter((topicSlug): topicSlug is string => Boolean(topicSlug));

  return {
    kind: 'workstream',
    id: workstream.id,
    title: workstream.title,
    slug,
    status: workstream.status,
    createdAt: workstream.opened_at,
    updatedAt: workstream.updated_at,
    closure: workstream.closure,
    resourceVersion: workstream.resourceVersion,
    editable: Boolean(slug),
    topics: ordered,
    tree: groups.map(treeGroup),
    agentMessages: buildAgentMessageVMs(agentMessages, {
      topicSlugs: memberSlugs,
      topicIds: topics.map((topic) => topic.id),
      workstreamIds: [workstream.id],
    }, now),
  };
}