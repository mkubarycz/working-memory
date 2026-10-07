import type { ChatContext } from '../shared/contracts';
import type { ChatRun } from './chatHistory';

export function chatRunDomId(run: ChatRun): string {
  return `chat-run-${encodeURIComponent(run.journalId ?? run.key)}`;
}

export function abbreviatedMessage(value: string, maxWords = 7): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}…`;
}

export function recentRunsForContext(
  runs: ChatRun[],
  context: ChatContext | undefined,
  limit = 2,
): ChatRun[] {
  if (!context || limit <= 0) return [];
  const contextKind = context.kind.toLowerCase().replaceAll('-', '');
  const matchesContext = (ref: ChatRun['scope'] | ChatRun['entityRefs'][number]) => (
    ref.kind.toLowerCase().replaceAll('-', '') === contextKind
    && (ref.slug === context.identifier || ref.id === context.identifier)
  );
  return runs
    .filter((run) => matchesContext(run.scope) || run.entityRefs.some(matchesContext))
    .sort((left, right) => right.startedAt - left.startedAt
      || (right.journalId ?? right.key).localeCompare(left.journalId ?? left.key))
    .slice(0, limit);
}