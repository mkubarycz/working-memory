import type { AgentMessage } from '../controlPlaneClient';

export interface AgentMessageVM {
  id: string;
  title: string;
  description: string;
  recommendedAction: string;
  status: AgentMessage['status'];
  category: AgentMessage['category'];
  severity: AgentMessage['severity'];
  attention: boolean;
  topics: string[];
  relations: AgentMessage['relations'];
  provenance?: AgentMessage['provenance'];
  decision?: AgentMessage['decision'];
  /** Unix epoch seconds, matching control-plane document metadata. */
  createdAt: number;
  /** Unix epoch seconds, not the chat-run millisecond timebase. */
  updatedAt: number;
  dimmed: boolean;
}

export function toAgentMessageVM(message: AgentMessage): AgentMessageVM {
  return {
    id: message.id,
    title: message.title.trim() || message.description.split('\n')[0] || 'Agent message',
    description: message.description,
    recommendedAction: message.recommended_action,
    status: message.status,
    category: message.category,
    severity: message.severity,
    attention: message.attention,
    topics: [...message.topics],
    relations: message.relations.map((relation) => ({ ...relation })),
    ...(message.provenance ? { provenance: { ...message.provenance } } : {}),
    ...(message.decision ? { decision: { ...message.decision } } : {}),
    createdAt: message.created_at,
    updatedAt: message.updated_at,
    dimmed: message.status !== 'open',
  };
}

export interface AgentMessageScope {
  topicSlugs: readonly string[];
  topicIds?: readonly string[];
  workstreamIds?: readonly string[];
}

function scopedMessagePredicate(scope: readonly string[] | AgentMessageScope): (message: AgentMessage) => boolean {
  const selected = Array.isArray(scope)
    ? { topicSlugs: scope } as AgentMessageScope
    : scope as AgentMessageScope;
  const slugs = new Set(selected.topicSlugs.filter(Boolean));
  const topicIds = new Set((selected.topicIds ?? []).filter(Boolean));
  const workstreamIds = new Set((selected.workstreamIds ?? []).filter(Boolean));
  return (message) => message.topics.some((slug) => slugs.has(slug))
    || message.relations.some((relation) =>
      relation.kind === 'Topic' && topicIds.has(relation.id)
      || relation.kind === 'Workstream' && workstreamIds.has(relation.id));
}

/** Preserve complete history, scoped by authored topic slugs and explicit document IDs. */
export function buildAgentMessageVMs(
  messages: AgentMessage[],
  scope: readonly string[] | AgentMessageScope,
  _now?: number,
): AgentMessageVM[] {
  const matches = scopedMessagePredicate(scope);
  const rank = { open: 0, acknowledged: 1, resolved: 2 };
  return messages
    .filter(matches)
    .sort((a, b) => rank[a.status] - rank[b.status] || b.updated_at - a.updated_at)
    .map(toAgentMessageVM);
}

export interface AgentMessageBubble {
  count: number;
  severity: AgentMessage['severity'] | null;
}

export function agentMessageBubbleForTopics(
  messages: AgentMessage[],
  scope: readonly string[] | AgentMessageScope,
): AgentMessageBubble {
  const matches = scopedMessagePredicate(scope);
  const seen = new Set<string>();
  const rank = { info: 0, warning: 1, error: 2 };
  let severity: AgentMessage['severity'] | null = null;
  for (const message of messages) {
    if (message.status !== 'open' || !message.attention || seen.has(message.id)
      || !matches(message)) continue;
    seen.add(message.id);
    if (severity === null || rank[message.severity] > rank[severity]) severity = message.severity;
  }
  return { count: seen.size, severity };
}

export function agentMessageBubbleForTopic(messages: AgentMessage[], slug: string, id?: string): AgentMessageBubble {
  return agentMessageBubbleForTopics(messages, { topicSlugs: [slug], topicIds: id ? [id] : [] });
}
