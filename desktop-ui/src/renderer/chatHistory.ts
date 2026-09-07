import type {
  CommandJournal,
  CommandJournalEntityRef,
  CommandJournalEvent,
  CommandJournalScopeRef,
  CommandJournalStatus,
  CommandJournalSummary,
  CommandJournalToolEventSummary,
} from '../../../src/controlPlaneClient';
import type { ChatResult, DesktopResourceKind, PendingConfirmation, ToolProgress } from '../shared/contracts';

export interface ChatTarget {
  kind: DesktopResourceKind;
  identifier: string;
}

export interface ChatToolRow {
  journalId: string;
  sequence: number;
  toolName: string;
  mode: 'read' | 'write';
  status: CommandJournalToolEventSummary['status'];
  entity?: { label: string; target?: ChatTarget };
}

export interface ChatRun {
  key: string;
  journalId?: string;
  resourceVersion?: number;
  startedAt: number;
  completedAt?: number;
  status: CommandJournalStatus | 'submitting';
  userText: string;
  scope: CommandJournalScopeRef;
  assistantText?: string;
  tools: ChatToolRow[];
  progress?: ToolProgress[];
  pendingConfirmation?: PendingConfirmation;
}

export interface ToolDetail {
  call: Extract<CommandJournalEvent, { type: 'tool_call' }>;
  result?: Extract<CommandJournalEvent, { type: 'tool_result' }>;
  confirmation?: {
    requested?: Extract<CommandJournalEvent, { type: 'confirmation_requested' }>;
    resolved?: Extract<CommandJournalEvent, { type: 'confirmation_resolved' }>;
  };
  partial: boolean;
}

const TARGET_KINDS: Record<string, DesktopResourceKind> = {
  workstream: 'workstream',
  topic: 'topic',
  alert: 'alert',
  topictype: 'topic-type',
  'topic-type': 'topic-type',
  nanite: 'document',
  nanitetemplate: 'document',
  nanitejournal: 'document',
  document: 'document',
};

const WRITE_ACTION = /-(?:create|update|delete|run)$/;

export function targetForRef(ref: CommandJournalScopeRef | CommandJournalEntityRef): ChatTarget | undefined {
  const kind = TARGET_KINDS[ref.kind.toLowerCase()];
  const identifier = ref.slug ?? ref.id;
  return kind && identifier ? { kind, identifier } : undefined;
}

export function toolMode(toolName: string): 'read' | 'write' {
  return WRITE_ACTION.test(toolName) ? 'write' : 'read';
}

function entityForTool(
  tool: CommandJournalToolEventSummary,
  refs: CommandJournalEntityRef[],
): ChatToolRow['entity'] {
  const family = tool.toolName.match(/^ws-([a-z]+)-/)?.[1];
  if (!family) return undefined;
  const ref = refs.find((candidate) => candidate.kind.toLowerCase().replaceAll('-', '') === family);
  if (!ref) return undefined;
  return {
    label: ref.title ?? ref.slug ?? ref.id,
    target: targetForRef(ref),
  };
}

export function summaryToChatRun(summary: CommandJournalSummary): ChatRun {
  return {
    key: summary.id,
    journalId: summary.id,
    resourceVersion: summary.resourceVersion,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    status: summary.status,
    userText: summary.request.userText,
    scope: summary.primaryScope,
    assistantText: summary.completion?.finalAssistantText,
    tools: summary.eventSummaries.map((tool) => ({
      journalId: summary.id,
      sequence: tool.sequence,
      toolName: tool.toolName,
      mode: toolMode(tool.toolName),
      status: tool.status,
      entity: entityForTool(tool, summary.entityRefs),
    })),
  };
}

export function journalToSummary(journal: CommandJournal): CommandJournalSummary {
  const results = new Map(
    journal.events
      .filter((event): event is Extract<CommandJournalEvent, { type: 'tool_result' }> => event.type === 'tool_result')
      .map((event) => [event.callId, event.status]),
  );
  return {
    id: journal.id,
    resourceVersion: journal.resourceVersion,
    createdAt: journal.createdAt,
    startedAt: journal.startedAt,
    completedAt: journal.completedAt,
    status: journal.status,
    request: journal.request,
    primaryScope: journal.primaryScope,
    entityRefs: journal.entityRefs,
    completion: journal.completion && {
      finalAssistantText: journal.completion.finalAssistantText,
      stopReason: journal.completion.stopReason,
      mutated: journal.completion.mutated,
      navigationTarget: journal.completion.navigationTarget,
    },
    eventSummaries: journal.events
      .filter((event): event is Extract<CommandJournalEvent, { type: 'tool_call' }> => event.type === 'tool_call')
      .map((event) => ({
        sequence: event.sequence,
        timestamp: event.timestamp,
        toolName: event.toolName,
        callId: event.callId,
        status: results.get(event.callId) ?? 'pending',
      })),
  };
}

export function mergeHistoryRuns(current: ChatRun[], summaries: CommandJournalSummary[]): ChatRun[] {
  const merged = new Map(current.map((run) => [run.journalId ?? run.key, run]));
  for (const summary of summaries) {
    const persisted = summaryToChatRun(summary);
    const live = merged.get(summary.id);
    merged.set(summary.id, live
      ? {
          ...live,
          ...persisted,
          progress: live.progress,
          pendingConfirmation: live.pendingConfirmation,
        }
      : persisted);
  }
  return [...merged.values()].sort((left, right) =>
    left.startedAt - right.startedAt || (left.journalId ?? left.key).localeCompare(right.journalId ?? right.key));
}

export function createLiveRun(
  key: string,
  userText: string,
  scope: CommandJournalScopeRef,
  startedAt: number,
): ChatRun {
  return { key, startedAt, status: 'submitting', userText, scope, tools: [] };
}

export function reconcileLiveRun(runs: ChatRun[], key: string, result: ChatResult): ChatRun[] {
  const localIndex = runs.findIndex((run) => run.key === key);
  const index = localIndex >= 0
    ? localIndex
    : runs.findIndex((run) => result.journalId && run.journalId === result.journalId);
  if (index < 0) return runs;
  const current = runs[index];
  const replacement: ChatRun = {
    ...current,
    key: result.journalId ?? current.key,
    journalId: result.journalId ?? current.journalId,
    status: result.pendingConfirmation ? 'awaiting_confirmation' : 'running',
    assistantText: result.message,
    progress: result.progress,
    pendingConfirmation: result.pendingConfirmation,
  };
  const withoutDuplicates = runs.filter((run, candidate) => candidate === index || (
    run.key !== key && (!replacement.journalId || run.journalId !== replacement.journalId)
  ));
  return withoutDuplicates.map((run) => run === current ? replacement : run);
}

export function toolDetail(journal: CommandJournal, sequence: number): ToolDetail | undefined {
  const call = journal.events.find((event): event is Extract<CommandJournalEvent, { type: 'tool_call' }> =>
    event.type === 'tool_call' && event.sequence === sequence);
  if (!call) return undefined;
  const result = journal.events.find((event): event is Extract<CommandJournalEvent, { type: 'tool_result' }> =>
    event.type === 'tool_result' && event.callId === call.callId);
  const requested = journal.events.find((event): event is Extract<CommandJournalEvent, { type: 'confirmation_requested' }> =>
    event.type === 'confirmation_requested' && event.callId === call.callId);
  const resolved = journal.events.find((event): event is Extract<CommandJournalEvent, { type: 'confirmation_resolved' }> =>
    event.type === 'confirmation_resolved' && event.callId === call.callId);
  return {
    call,
    result,
    ...(requested || resolved ? { confirmation: { requested, resolved } } : {}),
    partial: !result,
  };
}

export function formatDetailValue(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}