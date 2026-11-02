import type { AgentMessage } from '../controlPlaneClient';

export interface AgentMessageVM {
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  description: string;
  recommendedAction: string;
  status: AgentMessage['status'];
  category: AgentMessage['category'];
  dueAt?: number;
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
    agentId: message.agent_id,
    agentName: message.agent_name,
    title: message.title.trim() || message.description.split('\n')[0] || 'Agent message',
    description: message.description,
    recommendedAction: message.recommended_action,
    status: message.status,
    category: message.category,
    ...(message.due_at !== undefined ? { dueAt: message.due_at } : {}),
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

  topicIds?: readonly string[];
  workstreamIds?: readonly string[];
}

function scopedMessagePredicate(scope: readonly string[] | AgentMessageScope): (message: AgentMessage) => boolean {
  const selected = Array.isArray(scope)
    ? { topicIds: scope } as AgentMessageScope
    : scope as AgentMessageScope;
  const ids = new Set((selected.topicIds ?? []).filter(Boolean));
  const topicIds = new Set((selected.topicIds ?? []).filter(Boolean));
  const workstreamIds = new Set((selected.workstreamIds ?? []).filter(Boolean));
  return (message) => message.topics.some((id) => ids.has(id))
    || message.relations.some((relation) =>
      relation.kind === 'Topic' && topicIds.has(relation.id)
      || relation.kind === 'Workstream' && workstreamIds.has(relation.id));
}

/** Preserve complete history, scoped by authored topic ids and explicit document IDs. */
export function compareAgentMessages(a: AgentMessage, b: AgentMessage): number {
  const rank = { open: 0, acknowledged: 1, resolved: 2 };
  return rank[a.status] - rank[b.status]
    || (a.status === 'open'
      ? Number(b.category === 'reminder') - Number(a.category === 'reminder')
        || (a.category === 'reminder' && b.category === 'reminder' ? a.due_at! - b.due_at! : 0)
      : 0)
    || b.updated_at - a.updated_at;
}

export function buildAgentMessageVMs(
  messages: AgentMessage[],
  scope: readonly string[] | AgentMessageScope,
  _now?: number,
): AgentMessageVM[] {
  const matches = scopedMessagePredicate(scope);
  return messages
    .filter(matches)
    .sort(compareAgentMessages)
    .map(toAgentMessageVM);
}

export type AgentMessageDisplaySeverity = AgentMessage['severity'] | 'overdue';

export interface AgentMessageBubble {
  count: number;
  severity: AgentMessageDisplaySeverity | null;
}

export function agentMessageBubbleForTopics(
  messages: AgentMessage[],
  scope: readonly string[] | AgentMessageScope,
): AgentMessageBubble {
  const matches = scopedMessagePredicate(scope);
  const seen = new Set<string>();
  const rank = { info: 0, warning: 1, error: 2, overdue: 3 };
  let severity: AgentMessageDisplaySeverity | null = null;
  for (const message of messages) {
    if (message.status !== 'open' || !message.attention || seen.has(message.id)
      || !matches(message)) continue;
    seen.add(message.id);
    const displaySeverity = message.category === 'reminder' ? 'overdue' : message.severity;
    if (severity === null || rank[displaySeverity] > rank[severity]) severity = displaySeverity;
  }
  return { count: seen.size, severity };
}

export function agentMessageBubbleForTopic(messages: AgentMessage[], id: string): AgentMessageBubble {
  return agentMessageBubbleForTopics(messages, {  topicIds: id ? [id] : [] });
}
