import type { AgentMessageVM, DocumentVM, WorkstreamVM } from './documents/types';
import type { ChatRun } from './chatHistory';
import { allRunsForContext, type ScopedChatContext } from './scopedChat';
import { normalizeScopeKind as normalizeKind } from './scopeIdentity';

export type MessageRow =
  | { kind: 'run'; key: string; timestamp: number; run: ChatRun }
  | { kind: 'agent-message'; key: string; timestamp: number; message: AgentMessageVM };

export function messageNeedsAttention(message: AgentMessageVM): boolean {
  return message.status === 'open' && message.attention;
}

export function messageStatusActions(status: AgentMessageVM['status']): {
  label: string; status: AgentMessageVM['status'];
}[] {
  if (status === 'open') return [
    { label: 'Acknowledge', status: 'acknowledged' }, { label: 'Resolve', status: 'resolved' },
  ];
  return [
    ...(status === 'acknowledged' ? [{ label: 'Resolve', status: 'resolved' as const }] : []),
    { label: 'Reopen', status: 'open' },
  ];
}

export function messagesForContext(messages: AgentMessageVM[], context: ScopedChatContext | undefined,
  document?: DocumentVM | null): AgentMessageVM[] {
  if (!context) return [];
  const identifiers = new Set([context.identifier, context.id].filter((id): id is string => !!id));
  const topicIdentifiers = new Set<string>();
  if (normalizeKind(context.kind) === 'topic') identifiers.forEach((id) => topicIdentifiers.add(id));
  if (document?.kind === 'workstream') {
    for (const topic of (document as WorkstreamVM).topics) {
      if (topic.id) topicIdentifiers.add(topic.id);
      if (topic.slug) topicIdentifiers.add(topic.slug);
    }
    const walk = (nodes: WorkstreamVM['tree'][number]['children']) => {
      for (const node of nodes) {
        if (node.documentId) topicIdentifiers.add(node.documentId);
        if (node.slug) topicIdentifiers.add(node.slug);
        walk(node.children);
      }
    };
    for (const group of (document as WorkstreamVM).tree) walk(group.children);
  }
  return messages.filter((message) =>
    (normalizeKind(context.kind) === 'agentmessage' && (identifiers.has(message.id) || !!message.slug && identifiers.has(message.slug)))
    || message.topics.some((topic) => topicIdentifiers.has(topic))
    || message.relations.some((relation) =>
      normalizeKind(relation.kind) === normalizeKind(context.kind) && identifiers.has(relation.id)
      || normalizeKind(relation.kind) === 'topic' && topicIdentifiers.has(relation.id)));
}

export function mergeMessageRows(runs: ChatRun[], messages: AgentMessageVM[]): MessageRow[] {
  const rows = new Map<string, MessageRow>();
  for (const run of runs) {
    const key = `run:${run.journalId ?? run.key}`;
    rows.set(key, { kind: 'run', key, timestamp: run.startedAt, run });
  }
  for (const message of messages) {
    const key = `agent-message:${message.id}`;
    rows.set(key, { kind: 'agent-message', key, timestamp: message.createdAt * 1000, message });
  }
  return [...rows.values()].sort((a, b) => a.timestamp - b.timestamp || a.key.localeCompare(b.key));
}

export function scopedMessageRows(runs: ChatRun[], messages: AgentMessageVM[],
  context: ScopedChatContext | undefined, document?: DocumentVM | null): MessageRow[] {
  return mergeMessageRows(allRunsForContext(runs, context), messagesForContext(messages, context, document));
}

export async function loadAllAgentMessages(
  readPage: (input: { limit: number; offset: number }) => Promise<AgentMessageVM[]>,
  isCurrent: () => boolean,
  onPage: (messages: AgentMessageVM[]) => void,
): Promise<void> {
  const limit = 100;
  let offset = 0;
  const seen = new Set<string>();
  while (isCurrent()) {
    const page = await readPage({ limit, offset });
    if (!isCurrent()) return;
    if (!page.length) return;
    const fresh = page.filter((message) => !seen.has(message.id));
    if (!fresh.length) throw new Error('Agent message pagination did not advance.');
    fresh.forEach((message) => seen.add(message.id));
    onPage(fresh);
    if (page.length < limit) return;
    offset += page.length;
  }
}
