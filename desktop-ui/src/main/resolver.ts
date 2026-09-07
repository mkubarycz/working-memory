import type { ControlPlaneClient, DocumentEnvelope, Topic, Workstream } from '../../../src/controlPlaneClient';
import { buildWorkstreamPanels, type PanelData, type WorkstreamSection } from '../../../src/panelData';
import { alertBubbleForTopic, buildAlertVMs } from '../../../src/webview/alertVms';
import type { GenericDocVM, RelationVM, TopicVM } from '../../../webview-ui/src/lib/types';
export { loadWorkstreamViewModel } from '../../../src/webview/workstreamViewModel';

export async function loadActivePanelData(client: ControlPlaneClient): Promise<PanelData> {
  try {
    const [workstreams, topics, alerts, topicTypes, nanites, naniteTemplates] = await Promise.all([
      client.wsRead({}),
      client.topicRead({}),
      client.alertRead({}),
      client.topicTypeRead({}),
      client.naniteRead({}),
      client.naniteTemplateRead({}),
    ]);
    return buildWorkstreamPanels({
      available: true,
      workstreams,
      topics,
      alerts,
      topicTypes,
      nanites,
      naniteTemplates,
    }).active;
  } catch (error) {
    return buildWorkstreamPanels({
      available: false,
      workstreams: [],
      error: error instanceof Error ? error.message : String(error),
    }).active;
  }
}

export function resolveDesktopResourceUri(uri: string): {
  kind: 'workstream' | 'topic' | 'document' | 'alert' | 'topic-type';
  identifier: string;
} | null {
  const match = /^working-memory:\/(workstream|topic|document|alert|topic-type)\/(.+)\.working-memory$/.exec(uri);
  if (!match) return null;
  try {
    return {
      kind: match[1] as 'workstream' | 'topic' | 'document' | 'alert' | 'topic-type',
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
    (item) => item.slug?.toLowerCase() === needle || item.title.toLowerCase() === needle,
  );
  if (exact) return exact;
  const tokens = needle
    .split(/[^a-z0-9]+/)
    .filter((token) => token && token !== 'the' && token !== 'workstream');
  const ranked = candidates
    .map((item, index) => {
      const haystack = `${item.slug ?? ''} ${item.title}`.toLowerCase();
      const score = tokens.reduce((total, token) => total + (haystack.includes(token) ? 1 : 0), 0);
      return { item, index, score };
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked[0]?.item ?? null;
}

async function readTopic(client: ControlPlaneClient, identifier: string): Promise<Topic | null> {
  const bySlug = await client.topicRead({ slug: identifier });
  if (bySlug[0]) return bySlug[0];
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
  const [allTopics, workstreams, alerts, topicTypes] = await Promise.all([
    client.topicRead().catch(() => []),
    client.wsRead().catch(() => []),
    client.alertRead().catch(() => []),
    client.topicTypeRead().catch(() => []),
  ]);
  const topicTitles = new Map(allTopics.flatMap((item) => item.slug ? [[item.slug, item.title]] : []));
  const workstreamTitles = new Map(workstreams.flatMap((item) => item.slug ? [[item.slug, item.title]] : []));
  const relation = (slug: string, titles: Map<string, string>): RelationVM => ({
    slug, title: titles.get(slug) ?? slug, alertCount: 0, alertSeverity: null,
  });
  const topicRelation = (slug: string, title: string): RelationVM => {
    const bubble = alertBubbleForTopic(alerts, slug);
    return { slug, title, alertCount: bubble.count, alertSeverity: bubble.severity };
  };
  const type = topicTypes.find((item) => item.slug === topic.topicType || item.id === topic.topicType);
  return {
    kind: 'topic',
    title: topic.title,
    slug: topic.slug,
    status: topic.status,
    topicType: topic.topicType,
    typeMeta: type ? { slug: type.slug, label: type.label, icon: type.icon, description: type.description } : null,
    body: topic.body,
    createdAt: topic.created_at,
    updatedAt: topic.updated_at,
    resourceVersion: topic.resourceVersion,
    editable: Boolean(topic.slug),
    parents: topic.parents.map((slug) => topicRelation(slug, topicTitles.get(slug) ?? slug)),
    children: topic.slug
      ? allTopics.filter((item) => item.slug && item.parents.includes(topic.slug!))
          .map((item) => topicRelation(item.slug!, item.title)).sort((a, b) => a.title.localeCompare(b.title))
      : [],
    workstreams: topic.workstreams.map((slug) => relation(slug, workstreamTitles)),
    focusedWorkstreams: topic.focusedWorkstreams.map((slug) => relation(slug, workstreamTitles)),
    alerts: buildAlertVMs(alerts, topic.slug ? [topic.slug] : [], now),
  };
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

export function toGenericDocumentViewModel(document: DocumentEnvelope): GenericDocVM {
  const titleValue = document.spec.title ?? document.spec.name ?? document.metadata.slug ?? document.kind;
  return {
    kind: document.kind,
    id: document.metadata.id,
    slug: document.metadata.slug,
    title: displayValue(titleValue),
    createdAt: document.metadata.createdAt,
    updatedAt: document.metadata.updatedAt,
    resourceVersion: document.metadata.resourceVersion,
    spec: Object.entries(document.spec).map(([key, value]) => ({ key, value: displayValue(value) })),
  };
}

export type DesktopAction =
  | { kind: 'nanite'; operation: 'run' | 'reset' | 'restart'; id: string }
  | { kind: 'topic'; operation: 'attach' | 'detach'; slug: string; workstream: string }
  | { kind: 'workstream'; operation: 'move'; slug: string; section: WorkstreamSection };

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
    const slug = 'slug' in value && typeof value.slug === 'string' ? value.slug : '';
    const section = 'section' in value &&
      (value.section === 'queue' || value.section === 'progress' || value.section === 'backlog')
      ? value.section
      : null;
    if (slug && section) return { kind: 'workstream', operation: 'move', slug, section };
  }
  if (command.startsWith('workingMemory.nanite.')) {
    if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'string') {
      throw new Error('This action is missing its document id.');
    }
    const operation = command.slice('workingMemory.nanite.'.length);
    if (operation === 'run' || operation === 'reset' || operation === 'restart') {
      return { kind: 'nanite', operation, id: value.id };
    }
  }
  const topicSlug = value && typeof value === 'object' && 'topicSlug' in value && typeof value.topicSlug === 'string'
    ? value.topicSlug : '';
  if (topicSlug && command === 'workingMemory.topic.addToWorkstream') {
    return { kind: 'topic', operation: 'attach', slug: topicSlug, workstream };
  }
  if (topicSlug && command === 'workingMemory.topic.removeFromWorkstream') {
    return { kind: 'topic', operation: 'detach', slug: topicSlug, workstream };
  }
  throw new Error(`Unsupported desktop action: ${command}`);
}
