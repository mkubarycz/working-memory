import type { ChatContext } from '../shared/contracts';
import type { ChatRun } from './chatHistory';

export function chatRunDomId(run: ChatRun): string {
  return `chat-run-${encodeURIComponent(run.journalId ?? run.key)}`;
}

export function recentRunsForContext(
  runs: ChatRun[],
  context: ChatContext | undefined,
  limit = 2,
): ChatRun[] {
  if (!context || limit <= 0) return [];
  const contextKind = context.kind.toLowerCase().replaceAll('-', '');
  return runs
    .filter((run) => (
      run.scope.kind.toLowerCase().replaceAll('-', '') === contextKind
      && (run.scope.slug ?? run.scope.id) === context.identifier
    ))
    .sort((left, right) => right.startedAt - left.startedAt
      || (right.journalId ?? right.key).localeCompare(left.journalId ?? left.key))
    .slice(0, limit);
}