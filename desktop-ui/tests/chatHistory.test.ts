import { describe, expect, it } from 'vitest';
import type { CommandJournal, CommandJournalSummary } from '../../src/controlPlaneClient';
import {
  chatContextForScope,
  createLiveRun,
  isRetryableRun,
  journalToSummary,
  mergeHistoryRuns,
  reconcileLiveRun,
  refreshLatestRuns,
  summaryToChatRun,
  targetForRef,
  toolDetail,
  toolMode,
} from '../src/renderer/chatHistory';

function summary(overrides: Partial<CommandJournalSummary> = {}): CommandJournalSummary {
  return {
    id: 'journal-1',
    resourceVersion: 1,
    createdAt: 10,
    startedAt: 10,
    status: 'succeeded',
    request: { userText: 'Show roadmap' },
    primaryScope: { kind: 'Workstream', id: 'roadmap-id', slug: 'roadmap', title: 'Roadmap' },
    entityRefs: [{ kind: 'Topic', id: 'topic-id', slug: 'ship-it', title: 'Ship it', relation: 'referenced' }],
    completion: { finalAssistantText: 'Here it is.', stopReason: 'completed', mutated: false },
    eventSummaries: [{ sequence: 2, timestamp: 12, toolName: 'ws-topic-read', callId: 'call-1', status: 'success' }],
    ...overrides,
  };
}

describe('chat history presentation', () => {
  it('merges newest-first pages into deterministic chronological runs without duplicates', () => {
    const newest = summary({ id: 'new', startedAt: 30 });
    const middle = summary({ id: 'middle', startedAt: 20 });
    const oldest = summary({ id: 'old', startedAt: 10 });
    const first = mergeHistoryRuns([], [newest, middle]);
    const merged = mergeHistoryRuns(first, [middle, oldest]);
    expect(merged.map((run) => run.journalId)).toEqual(['old', 'middle', 'new']);
  });

  it('reconciles newest-page updates while preserving older and local runs', () => {
    const local = createLiveRun('local-1', 'Pending', { kind: 'DesktopChat', id: 'desktop-chat' }, 40);
    const old = summary({ id: 'old', startedAt: 10 });
    const running = summary({ id: 'running', startedAt: 30, status: 'running', completion: undefined });
    const refreshed = refreshLatestRuns(
      mergeHistoryRuns([local], [old, running]),
      [summary({ id: 'running', startedAt: 30, status: 'succeeded' }), summary({ id: 'external', startedAt: 35 })],
    );
    expect(refreshed.map((run) => [run.key, run.status])).toEqual([
      ['old', 'succeeded'], ['running', 'succeeded'], ['external', 'succeeded'], ['local-1', 'submitting'],
    ]);
  });

  it('ignores an out-of-order persisted summary older than the journal-backed run', () => {
    const newest = summaryToChatRun(summary({
      resourceVersion: 4,
      status: 'failed',
      completion: { finalAssistantText: 'Newest failure', stopReason: 'error', mutated: true },
    }));
    const stale = summary({
      resourceVersion: 3,
      status: 'running',
      completion: undefined,
    });

    const [merged] = mergeHistoryRuns([newest], [stale]);

    expect(merged).toMatchObject({
      resourceVersion: 4,
      status: 'failed',
      assistantText: 'Newest failure',
      mutated: true,
    });
  });

  it('replaces an optimistic retry with its polled journal without changing the failed attempt', () => {
    const failed = summary({ id: 'failed', startedAt: 10, status: 'failed' });
    const retry = createLiveRun('local-retry', failed.request.userText, failed.primaryScope, 100);
    const runningRetry = summary({
      id: 'retry-journal',
      startedAt: 101,
      status: 'running',
      completion: undefined,
    });

    const refreshed = refreshLatestRuns([...mergeHistoryRuns([], [failed]), retry], [runningRetry]);

    expect(refreshed.map((run) => [run.key, run.status])).toEqual([
      ['failed', 'failed'],
      ['retry-journal', 'running'],
    ]);
  });

  it('reconciles a live request by stable journal id and preserves live progress', () => {
    const live = createLiveRun('local-1', 'Do it', { kind: 'DesktopChat', id: 'desktop-chat' }, 20);
    const persisted = summary({ id: 'journal-1', startedAt: 20, status: 'running', completion: undefined });
    const hydrated = mergeHistoryRuns([live], [persisted]);
    const reconciled = reconcileLiveRun(hydrated, 'local-1', {
      journalId: 'journal-1', message: 'Confirmation required.',
      status: 'awaiting_confirmation',
      progress: [{ name: 'ws-topic-read', status: 'completed', summary: 'Read Working Memory' }],
      pendingConfirmation: { id: 'confirm-1', tool: 'ws-topic-delete', arguments: { slug: 'old' } },
    });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ journalId: 'journal-1', status: 'awaiting_confirmation' });
    expect(reconciled[0].progress).toHaveLength(1);
  });

  it('uses an explicit failed result to terminate a local run without a journal reread', () => {
    const live = createLiveRun('local-1', 'Do it', { kind: 'DesktopChat', id: 'desktop-chat' }, 20);
    const [reconciled] = reconcileLiveRun([live], 'local-1', {
      message: 'Unable to complete that request.',
      status: 'failed',
    });
    expect(reconciled).toMatchObject({ key: 'local-1', status: 'failed', assistantText: 'Unable to complete that request.' });
  });

  it('derives retry context from supported journal scopes and leaves global chat unscoped', () => {
    expect(chatContextForScope({ kind: 'Topic', id: 'topic-id', slug: 'ship-it', title: 'Ship it' })).toEqual({
      kind: 'Topic', routeKind: 'topic', identifier: 'ship-it', title: 'Ship it',
    });
    expect(chatContextForScope({ kind: 'DesktopChat', id: 'desktop-chat' })).toBeUndefined();
    expect(chatContextForScope({ kind: 'Unknown', id: 'unknown' })).toBeUndefined();
  });

  it('retries only terminal failed or interrupted runs without a successful mutation', () => {
    const succeeded = summaryToChatRun(summary());
    expect(isRetryableRun(succeeded)).toBe(false);
    expect(isRetryableRun({ ...succeeded, status: 'failed' })).toBe(true);
    expect(isRetryableRun({ ...succeeded, status: 'interrupted' })).toBe(true);
    expect(isRetryableRun({
      ...succeeded,
      tools: [{ ...succeeded.tools[0], status: 'failure' }],
    })).toBe(false);
    expect(isRetryableRun({ ...succeeded, status: 'failed', mutated: true })).toBe(false);
    expect(isRetryableRun({ ...succeeded, status: 'interrupted', mutated: true })).toBe(false);
    expect(isRetryableRun({ ...succeeded, status: 'failed', mutated: false })).toBe(true);
    expect(isRetryableRun({ ...succeeded, status: 'failed', mutated: undefined })).toBe(true);
  });

  it('carries mutation state from persisted and optimistic run completions', () => {
    const persisted = summaryToChatRun(summary({
      status: 'failed',
      completion: { finalAssistantText: 'Stopped', stopReason: 'error', mutated: true },
    }));
    const local = createLiveRun('local-1', 'Do it', { kind: 'DesktopChat', id: 'desktop-chat' }, 20);
    const [reconciled] = reconcileLiveRun([local], 'local-1', {
      message: 'Stopped',
      status: 'failed',
      mutated: true,
    });

    expect(persisted.mutated).toBe(true);
    expect(reconciled.mutated).toBe(true);
  });

  it('presents scope targets and read/write tool rows with stable entity names', () => {
    expect(targetForRef({ kind: 'TopicType', id: 'type-1', slug: 'feature' })).toEqual({ kind: 'topic-type', identifier: 'feature' });
    expect(targetForRef({ kind: 'DesktopChat', id: 'desktop-chat' })).toBeUndefined();
    expect(toolMode('ws-topic-read')).toBe('read');
    expect(toolMode('ws-topic-update')).toBe('write');
    expect(summaryToChatRun(summary()).tools[0]).toMatchObject({
      mode: 'read', entity: { label: 'Ship it', target: { kind: 'topic', identifier: 'ship-it' } },
    });
  });

  it('extracts complete and interrupted tool detail explicitly', () => {
    const base = summary();
    const journal = {
      ...base,
      updatedAt: 14,
      schemaVersion: 2,
      provider: { endpoint: 'https://example.test', mode: 'responses', model: 'test' },
      events: [
        { id: 'event-1', sequence: 1, timestamp: 11, type: 'model_turn', role: 'assistant', iteration: 1, durationMs: 1 },
        { id: 'event-2', sequence: 2, timestamp: 12, type: 'tool_call', modelTurnId: 'event-1', callId: 'call-1', toolName: 'ws-topic-read', arguments: { slug: 'ship-it' } },
        { id: 'event-3', sequence: 3, timestamp: 13, type: 'tool_result', callId: 'call-1', status: 'success', result: { count: 1 }, durationMs: 4 },
      ],
    } as CommandJournal;
    expect(toolDetail(journal, 2)).toMatchObject({ partial: false, result: { status: 'success', durationMs: 4 } });
    expect(toolDetail({ ...journal, status: 'interrupted', events: journal.events.slice(0, 2) }, 2)).toMatchObject({ partial: true, result: undefined });
    expect(journalToSummary(journal).eventSummaries).toEqual([
      { sequence: 2, timestamp: 12, toolName: 'ws-topic-read', callId: 'call-1', status: 'success' },
    ]);
  });
});