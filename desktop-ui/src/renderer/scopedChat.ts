import type { ChatContext } from '../shared/contracts';
import type { ChatRun } from './chatHistory';

export function chatContextKey(context: ChatContext | undefined): string {
  return context ? `${context.kind.toLowerCase().replaceAll('-', '')}:${context.identifier}` : 'desktopchat:desktop-chat';
}

export function matchesChatContext(
  ref: ChatRun['scope'],
  context: ChatContext | undefined,
): boolean {
  const kind = ref.kind.toLowerCase().replaceAll('-', '');
  if (!context) return kind === 'desktopchat';
  return kind === context.kind.toLowerCase().replaceAll('-', '')
    && (ref.slug === context.identifier || ref.id === context.identifier);
}

export function chatContextBusy(runs: ChatRun[], context: ChatContext | undefined): boolean {
  return runs.some((run) => matchesChatContext(run.scope, context)
    && (run.status === 'submitting' || run.status === 'running'));
}

export function chatContextPending(runs: ChatRun[], context: ChatContext | undefined): ChatRun | undefined {
  return runs.find((run) => matchesChatContext(run.scope, context)
    && run.status === 'awaiting_confirmation' && run.pendingConfirmation);
}

export function chatRunDomId(run: ChatRun): string {
  return `chat-run-${encodeURIComponent(run.journalId ?? run.key)}`;
}

export function recentRunsForContext(
  runs: ChatRun[],
  context: ChatContext | undefined,
  limit = 2,
): ChatRun[] {
  if (!context || limit <= 0) return [];
  return runs
    .filter((run) => matchesChatContext(run.scope, context)
      || run.entityRefs.some((ref) => matchesChatContext(ref, context)))
    .sort((left, right) => right.startedAt - left.startedAt
      || (right.journalId ?? right.key).localeCompare(left.journalId ?? left.key))
    .slice(0, limit)
    .reverse();
}