import type { ChatContext } from '../shared/contracts';
import type { CommandJournalHistoryInput, CommandJournalHistoryPage, CommandJournalSummary } from '../../../shared/controlPlaneClient';
import { mergeHistoryRuns, summaryToChatRun, type ChatRun } from './chatHistory';
import { normalizeScopeKind } from './scopeIdentity';

export type ScopedChatContext = ChatContext;

export function collapseChatOnInteraction(node: HTMLElement, collapse: () => void): { destroy(): void } {
  node.addEventListener('pointerdown', collapse, { capture: true });
  node.addEventListener('keydown', collapse, { capture: true });
  return {
    destroy() {
      node.removeEventListener('pointerdown', collapse, { capture: true });
      node.removeEventListener('keydown', collapse, { capture: true });
    },
  };
}

export function chatContextKey(context: ChatContext | undefined): string {
  return context ? `${normalizeScopeKind(context.kind)}:${context.identifier}` : 'desktopchat:desktop-chat';
}

export function matchesChatContext(
  ref: ChatRun['scope'],
  context: ScopedChatContext | undefined,
): boolean {
  const kind = normalizeScopeKind(ref.kind);
  if (!context) return kind === 'desktopchat';
  return kind === normalizeScopeKind(context.kind) && ref.id === context.identifier;
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
  context: ScopedChatContext | undefined,
  limit = 5,
): ChatRun[] {
  if (!context || limit <= 0) return [];
  return allRunsForContext(runs, context).slice(-limit);
}

export function allRunsForContext(runs: ChatRun[], context: ScopedChatContext | undefined): ChatRun[] {
  if (!context) return [];
  return runs
    .filter((run) => matchesChatContext(run.scope, context)
      || run.entityRefs.some((ref) => matchesChatContext(ref, context)))
    .sort((left, right) => left.startedAt - right.startedAt
      || (left.journalId ?? left.key).localeCompare(right.journalId ?? right.key));
}

export function mergeScopedHistory(runs: ChatRun[], summaries: CommandJournalSummary[]): ChatRun[] {
  // Live results may be newer than a cached page but still carry the previous journal version.
  return mergeHistoryRuns(runs, summaries.filter((summary) => !runs.some((run) =>
    run.journalId === summary.id && (run.unpersistedResult
      || (run.resourceVersion ?? 0) >= summary.resourceVersion))));
}

export async function loadScopedHistory(
  context: ScopedChatContext,
  readPage: (input: CommandJournalHistoryInput) => Promise<CommandJournalHistoryPage>,
  isCurrent: () => boolean,
  onPage: (summaries: CommandJournalSummary[]) => void,
): Promise<void> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    if (!isCurrent()) return;
    // Scan pages to include both primary scopes and entity relationships.
    const page = await readPage({ limit: 100, ...(cursor ? { cursor } : {}) });
    if (!isCurrent()) return;
    onPage(page.journals.filter((summary) => allRunsForContext([summaryToChatRun(summary)], context).length > 0));
    cursor = page.nextCursor;
    if (cursor && seenCursors.has(cursor)) throw new Error('Scoped history pagination did not advance. Retry loading messages.');
    if (cursor) seenCursors.add(cursor);
  } while (cursor);
}