import type { ControlPlaneClient, DocumentEnvelope, Topic, Workstream } from '../../../shared/controlPlaneClient';
import { buildWorkstreamPanels, type PanelData, type WorkstreamSection } from '../../../shared/panelData';
import { agentMessageBubbleForTopic, agentMessageBubbleForTopics, buildAgentMessageVMs } from '../../../shared/viewModels/agentMessageVms';
import type { GenericDocVM, RelationVM, TopicVM } from '../renderer/documents/types';
import type { DesktopWorkstreamReorderUpdate } from '../shared/contracts';
export { loadWorkstreamViewModel } from '../../../shared/viewModels/workstreamViewModel';

export async function loadActivePanelData(client: ControlPlaneClient): Promise<PanelData> {
  try {
    const [workstreams, topics, agentMessages, topicTypes] = await Promise.all([
      client.wsRead({}),
      client.topicRead({}),
      client.agentMessageRead({}),
      client.topicTypeRead({}),
    ]);
    return buildWorkstreamPanels({
      available: true,
      workstreams,
      topics,
      agentMessages,
      topicTypes,
    }).active;
  } catch (error) {
    return buildWorkstreamPanels({
      available: false,
      workstreams: [],
      error: error instanceof Error ? error.message : String(error),
    }).active;
  }
}

export async function persistWorkstreamReorder(
  client: ControlPlaneClient,
  updates: DesktopWorkstreamReorderUpdate[],
): Promise<void> {
  for (const update of updates) {
    if (!update.id.trim() || !Number.isFinite(update.position) ||
      !['queue', 'progress', 'backlog'].includes(update.section)) {
      throw new Error('Invalid workstream reorder request.');
    }
  }
  if (updates.length === 0) return;
  await client.wsReorder({
    updates: updates.map((update) => ({
      id: update.id,
      status: update.section,
      position: update.position,
    })),
  });
}

export function resolveDesktopResourceUri(uri: string): {
  kind: 'workstream' | 'topic' | 'document' | 'agent-message' | 'topic-type';
  identifier: string;
} | null {
  const match = /^working-memory:\/(workstream|topic|document|alert|agent-message|topic-type)\/(.+)\.working-memory$/.exec(uri);
  if (!match) return null;
  try {
    return {
      kind: (match[1] === 'alert' ? 'agent-message' : match[1]) as 'workstream' | 'topic' | 'document' | 'agent-message' | 'topic-type',
      identifier: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

const ROADMAP_REQUEST = /(?:show|open|view|display)(?:\s+me)?(?:\s+the)?\s+(.+?)(?:\s+workstream)?[.!?]*$/i;

export function localWorkstreamQuery(message: string): string | null {
  const match = message.trim().match(ROADMAP_REQUEST);
  return match?.[1]?.trim() || null;
}

export function chooseWorkstream(query: string, candidates: Workstream[]): Workstream | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;
  const exact = candidates.find(
    (item) => item.id?.toLowerCase() === needle || item.title.toLowerCase() === needle,
  );
  if (exact) return exact;
  const tokens = needle
    .split(/[^a-z0-9]+/)
    .filter((token) => token && token !== 'the' && token !== 'workstream');
  const ranked = candidates
    .map((item, index) => {
      const haystack = `${item.id ?? ''} ${item.title}`.toLowerCase();
      const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
      return { item, index, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked[0]?.item ?? null;
}

async function readTopic(client: ControlPlaneClient, identifier: string): Promise<Topic | null> {
  const byId = await client.topicRead({ id: identifier });
  return byId[0] ?? null;
}

export async function loadTopicViewModel(
  client: ControlPlaneClient,
  identifier: string,
  now = Date.now(),
): Promise<TopicVM | null> {
  const topic = await readTopic(client, identifier);
  if (!topic) return null;
  const [allTopics, workstreams, agentMessages, topicTypes] = await Promise.all([
    client.topicRead().catch(() => []),
    client.wsRead().catch(() => []),
    client.agentMessageRead(),
    client.topicTypeRead().catch(() => []),
  ]);
  const topicTitles = new Map(allTopics.flatMap((item) => item.id ? [[item.id, item.title]] : []));
  const workstreamTitles = new Map(workstreams.flatMap((item) => item.id ? [[item.id, item.title]] : []));
  const relation = (id: string, titles: Map<string, string>): RelationVM => {
    const workstream = workstreams.find((item) => item.id === id);
    const members = allTopics.filter((item) => item.workstreams.includes(id));
    const bubble = agentMessageBubbleForTopics(agentMessages, {

      topicIds: members.map((item) => item.id),
      workstreamIds: workstream ? [workstream.id] : [],
    });
    return { id, title: titles.get(id) ?? id, agentMessageCount: bubble.count, agentMessageSeverity: bubble.severity };
  };
  const topicRelation = (id: string, title: string): RelationVM => {
    const relatedTopic = allTopics.find((item) => item.id === id);
    const bubble = agentMessageBubbleForTopic(agentMessages, id);
    return { id, title, agentMessageCount: bubble.count, agentMessageSeverity: bubble.severity };
  };
  const type = topicTypes.find((item) => item.id === topic.topicType || item.id === topic.topicType);
  const topicTypeOptions = topicTypes.map((item) => ({
    id: item.id,
    label: item.label,
    icon: item.icon,
    description: item.description,
  }));
  return {
    kind: 'topic',
    id: topic.id,
    title: topic.title,

    status: topic.status,
    topicType: topic.topicType,
    typeMeta: type ? { id: type.id, label: type.label, icon: type.icon, description: type.description } : null,
    topicTypes: topicTypeOptions,
    body: topic.body,
    createdAt: topic.created_at,
    updatedAt: topic.updated_at,
    resourceVersion: topic.resourceVersion,
    editable: Boolean(topic.id),
    parents: topic.parents.map((id) => topicRelation(id, topicTitles.get(id) ?? id)),
    children: topic.id
      ? allTopics.filter((item) => item.id && item.parents.includes(topic.id!))
          .map((item) => topicRelation(item.id!, item.title)).sort((a, b) => a.title.localeCompare(b.title))
      : [],
    workstreams: topic.workstreams.map((id) => relation(id, workstreamTitles)),
    focusedWorkstreams: topic.focusedWorkstreams.map((id) => relation(id, workstreamTitles)),
    agentMessages: buildAgentMessageVMs(agentMessages, {

      topicIds: [topic.id],
    }, now),
  };
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

export function toGenericDocumentViewModel(document: DocumentEnvelope): GenericDocVM {
  const titleValue = document.spec.title ?? document.spec.name ?? document.metadata.id ?? document.kind;
  return {
    kind: document.kind,
    id: document.metadata.id,

    title: displayValue(titleValue),
    createdAt: document.metadata.createdAt,
    updatedAt: document.metadata.updatedAt,
    resourceVersion: document.metadata.resourceVersion,
    spec: Object.entries(document.spec).map(([key, value]) => ({ key, value: displayValue(value) })),
  };
}

export type DesktopAction =
  | { kind: 'topic'; operation: 'attach' | 'detach'; id: string; workstream: string }
  | { kind: 'topic'; operation: 'transfer'; id: string; sourceWorkstream: string; targetWorkstream: string; move: boolean }
  | { kind: 'workstream'; operation: 'move'; id: string; section: WorkstreamSection };

export function resolveDesktopAction(
  command: string,
  args: unknown[],
  workstream: string,
): DesktopAction {
  const value = args[0];
  if (command === 'working-memory.setWorkstreamSection') {
    if (!value || typeof value !== 'object') {
      throw new Error('This action is missing its workstream details.');
    }
    const id = 'id' in value && typeof value.id === 'string' ? value.id : '';
    const section = 'section' in value &&
      (value.section === 'queue' || value.section === 'progress' || value.section === 'backlog')
      ? value.section
      : null;
    if (id && section) return { kind: 'workstream', operation: 'move', id, section };
  }
  const topicId = value && typeof value === 'object' && 'topicId' in value && typeof value.topicId === 'string'
    ? value.topicId : '';
  if (topicId && command === 'workingMemory.topic.addToWorkstream') {
    return { kind: 'topic', operation: 'attach', id: topicId, workstream };
  }
  if (topicId && command === 'workingMemory.topic.removeFromWorkstream') {
    return { kind: 'topic', operation: 'detach', id: topicId, workstream };
  }
  if (topicId && command === 'workingMemory.topic.transfer') {
    const sourceWorkstream = value && typeof value === 'object' && 'sourceWorkstream' in value &&
      typeof value.sourceWorkstream === 'string' ? value.sourceWorkstream : '';
    const move = Boolean(value && typeof value === 'object' && 'move' in value && value.move === true);
    if (sourceWorkstream && workstream && sourceWorkstream !== workstream) {
      return {
        kind: 'topic', operation: 'transfer', id: topicId,
        sourceWorkstream, targetWorkstream: workstream, move,
      };
    }
  }
  throw new Error(`Unsupported desktop action: ${command}`);
}
