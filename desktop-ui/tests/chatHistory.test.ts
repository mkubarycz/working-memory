import { describe, expect, it } from 'vitest';
import type { CommandJournal, CommandJournalSummary } from '../../src/controlPlaneClient';
import {
  createLiveRun,
  journalToSummary,
  mergeHistoryRuns,
  reconcileLiveRun,
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

  it('reconciles a live request by stable journal id and preserves live progress', () => {
    const live = createLiveRun('local-1', 'Do it', { kind: 'DesktopChat', id: 'desktop-chat' }, 20);
    const persisted = summary({ id: 'journal-1', startedAt: 20, status: 'running', completion: undefined });
    const hydrated = mergeHistoryRuns([live], [persisted]);
    const reconciled = reconcileLiveRun(hydrated, 'local-1', {
      journalId: 'journal-1', message: 'Confirmation required.',
      progress: [{ name: 'ws-topic-read', status: 'completed', summary: 'Read Working Memory' }],
      pendingConfirmation: { id: 'confirm-1', tool: 'ws-topic-delete', arguments: { slug: 'old' } },
    });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({ journalId: 'journal-1', status: 'awaiting_confirmation' });
    expect(reconciled[0].progress).toHaveLength(1);
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