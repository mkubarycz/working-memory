import type { AgentMessageVM, DocumentVM, WorkstreamVM } from './documents/types';
import type { ChatRun } from './chatHistory';
import { allRunsForContext, type ScopedChatContext } from './scopedChat';
import { normalizeScopeKind as normalizeKind } from './scopeIdentity';
import { formatRelativeDocumentTime } from './documentDates';
import { parse } from 'chrono-node';

export type MessageRow =
  | { kind: 'run'; key: string; timestamp: number; run: ChatRun }
  | { kind: 'agent-message'; key: string; timestamp: number; message: AgentMessageVM };

export function messageNeedsAttention(message: AgentMessageVM): boolean {
  return message.status === 'open' && message.attention;
}

export function reminderTiming(message: AgentMessageVM, now = Date.now()): { text: string; overdue: boolean } | null {
  if (message.category !== 'reminder') return null;
  if (message.dueAt === undefined || !Number.isSafeInteger(message.dueAt) || message.dueAt <= 0) {
    throw new Error('Reminder is missing a valid deadline in Unix seconds.');
  }
  if (message.status !== 'open') return { text: message.status === 'acknowledged' ? 'Acknowledged' : 'Resolved', overdue: false };
  return {
    text: `Due ${formatRelativeDocumentTime(message.dueAt, now)}`,
    overdue: message.dueAt * 1000 <= now,
  };
}

export function activeReminderRows(rows: MessageRow[]): Extract<MessageRow, { kind: 'agent-message' }>[] {
  return rows.filter((row): row is Extract<MessageRow, { kind: 'agent-message' }> =>
    row.kind === 'agent-message' && row.message.category === 'reminder' && row.message.status === 'open')
    .sort((a, b) => a.message.dueAt! - b.message.dueAt! || a.key.localeCompare(b.key));
}

export function snoozeDeadline(minutes: number, now = Date.now()): number {
  if (!Number.isSafeInteger(minutes) || minutes < 1) throw new Error('Snooze duration must be a positive number of minutes.');
  return Math.floor(now / 1000) + minutes * 60;
}

export function customReminderDeadline(value: string, now = Date.now()): number {
  const text = value.trim();
  if (!text || text.length > 500) throw new Error('Enter a time, such as "in 45 minutes" or "Friday at 2pm".');
  const results = parse(text, new Date(now), { forwardDate: true });
  if (!results.length) throw new Error('Could not understand that date and time. Try "in 45 minutes" or "Friday at 2pm".');
  if (results.length !== 1 || results[0].end) {
    throw new Error('Enter one date and time, not multiple dates or a time range.');
  }
  const seconds = Math.floor(results[0].date().getTime() / 1000);
  if (!Number.isSafeInteger(seconds) || seconds * 1000 <= now) {
    throw new Error('Choose a future reminder deadline.');
  }
  return seconds;
}

export type ReminderSnoozePreset = '10-minutes' | '1-hour' | 'tomorrow' | 'next-week';

export function presetReminderDeadline(preset: ReminderSnoozePreset, now = Date.now()): number {
  if (preset === '10-minutes') return snoozeDeadline(10, now);
  if (preset === '1-hour') return snoozeDeadline(60, now);
  const date = new Date(now);
  const days = preset === 'tomorrow' ? 1 : (8 - date.getDay()) % 7 || 7;
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
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
  if (!context?.identifier) return [];
  const identifiers = new Set([context.identifier]);
  const topicIdentifiers = new Set<string>();
  if (normalizeKind(context.kind) === 'topic') identifiers.forEach((id) => topicIdentifiers.add(id));
  if (document?.kind === 'workstream') {
    for (const topic of (document as WorkstreamVM).topics) {
      if (topic.id) topicIdentifiers.add(topic.id);
    }
    const walk = (nodes: WorkstreamVM['tree'][number]['children']) => {
      for (const node of nodes) {
        if (node.documentId) topicIdentifiers.add(node.documentId);
        walk(node.children);
      }
    };
    for (const group of (document as WorkstreamVM).tree) walk(group.children);
  }
  return messages.filter((message) =>
    (normalizeKind(context.kind) === 'agentmessage' && identifiers.has(message.id))
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
