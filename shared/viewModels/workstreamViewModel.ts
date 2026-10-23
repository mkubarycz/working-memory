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

  status: string;
  createdAt: number;
  updatedAt: number;
  closure: string | null;
  resourceVersion: number;
  editable: boolean;
  topics: Array<{ id: string; title: string;  status: string; pinned: boolean }>;
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

function topicIdFromUri(uri: string): string {
  const match = uri.match(/\/topic\/([^/]+)\.working-memory$/);
  return match ? decodeURIComponent(match[1]) : '';
}

function treeNode(row: PanelTopic): WorkstreamTreeTopicViewModel {
  return {
    kind: 'topic',
    id: row.documentId ?? topicIdFromUri(row.openUri),
    documentId: row.documentId,
    label: row.label,
    icon: row.icon,
    status: row.status,

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

  const id = workstream.id;
  let topics: Topic[] = [];
  let topicTypes: TopicType[] = [];
  let agentMessages: AgentMessage[] = [];
  if (id) {
    [topics, topicTypes] = await Promise.all([
      client.topicRead({ workstream: id }).catch(() => []),
      client.topicTypeRead().catch(() => []),
    ]);
  }
  agentMessages = await client.agentMessageRead();

  const rows = topics
    .map((topic) => ({
      id: topic.id,
      title: topic.title,

      status: topic.status,
      pinned: id ? topic.focusedWorkstreams.includes(id) : false,
    }))
    .sort((left, right) => left.title.localeCompare(right.title));
  const ordered = [...rows.filter((row) => row.pinned), ...rows.filter((row) => !row.pinned)];
  const typeMap = new Map(topicTypes.map((type) => [type.id, type]));
  const { groups } = buildWorkstreamTree(
    workstream.id,
    'active',
    id ? topics : undefined,
    typeMap,
    agentMessages,
  );
  const memberIds = topics
    .map((topic) => topic.id)
    .filter((topicId): topicId is string => Boolean(topicId));

  return {
    kind: 'workstream',
    id: workstream.id,
    title: workstream.title,

    status: workstream.status,
    createdAt: workstream.opened_at,
    updatedAt: workstream.updated_at,
    closure: workstream.closure,
    resourceVersion: workstream.resourceVersion,
    editable: Boolean(id),
    topics: ordered,
    tree: groups.map(treeGroup),
    agentMessages: buildAgentMessageVMs(agentMessages, {

      topicIds: topics.map((topic) => topic.id),
      workstreamIds: [workstream.id],
    }, now),
  };
}