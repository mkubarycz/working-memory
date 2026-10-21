import { describe, expect, it, vi } from 'vitest';
import type { CommandJournalHistoryPage, CommandJournalSummary } from '../../shared/controlPlaneClient';
import type { ChatRun } from '../src/renderer/chatHistory';
import { mergeHistoryRuns, reconcileLiveRun, summaryToChatRun } from '../src/renderer/chatHistory';
import { allRunsForContext, chatContextKey, chatRunDomId, loadScopedHistory, mergeScopedHistory, recentRunsForContext } from '../src/renderer/scopedChat';

function run(
  key: string,
  startedAt: number,
  kind: string,
  identifier: string,
  entityRefs: ChatRun['entityRefs'] = [],
): ChatRun {
  return {
    key, journalId: `journal/${key}`, startedAt, status: 'succeeded', userText: key,
    scope: { kind, id: `${identifier}-id`, slug: identifier, title: identifier }, entityRefs, tools: [], attachments: [],
  };
}

describe('scoped chat previews', () => {
  const context = { kind: 'topic', routeKind: 'topic' as const, identifier: 'selected', title: 'Selected' };

  it('loads real persisted historical Alert scope and entity refs under canonical AgentMessage identity', async () => {
    const selected = { kind: 'AgentMessage', routeKind: 'agent-message' as const, identifier: 'message-id', title: 'Message' };
    const summaries: CommandJournalSummary[] = ['Alert', 'agent-message'].map((kind, index) => ({
      id: `journal-${index}`, resourceVersion: 1, createdAt: 1, startedAt: index + 1,
      status: 'succeeded', request: { userText: `History ${index}` },
      primaryScope: { kind, id: 'message-id' }, entityRefs: [], eventSummaries: [],
    }));
    summaries.push({
      ...summaries[0], id: 'related', primaryScope: { kind: 'Topic', id: 'other' },
      entityRefs: [{ kind: 'alert', id: 'message-id', relation: 'referenced' }],
    });
    const loaded: CommandJournalSummary[] = [];
    await loadScopedHistory(selected, async () => ({ journals: summaries }), () => true,
      (page) => loaded.push(...page));
    expect(loaded.map((summary) => summary.id)).toEqual(['journal-0', 'journal-1', 'related']);
    expect(chatContextKey(selected)).toBe(chatContextKey({ ...selected, kind: 'alert' }));
    expect(allRunsForContext(loaded.map(summaryToChatRun), selected)).toHaveLength(3);
    expect(allRunsForContext(loaded.map(summaryToChatRun), { ...selected, identifier: 'unrelated' })).toEqual([]);
  });

  it('returns fewer than five matching runs when fewer are available', () => {
    const runs = [
      run('old', 10, 'Topic', 'selected'),
      run('wrong-kind', 40, 'Workstream', 'selected'),
      run('wrong-id', 50, 'Topic', 'selected-child'),
      run('middle', 20, 'topic', 'selected'),
      run('new', 30, 'topic', 'selected'),
    ];
    expect(recentRunsForContext(runs, context).map((item) => item.key)).toEqual(['old', 'middle', 'new']);
  });

  it('returns no previews without a selected document and creates a stable encoded DOM id', () => {
    const selected = run('stable', 10, 'Topic', 'selected');
    expect(recentRunsForContext([selected], undefined)).toEqual([]);
    expect(chatRunDomId(selected)).toBe('chat-run-journal%2Fstable');
  });

  it('includes runs that reference or mutate the current document from another primary scope', () => {
    const related = run('created-topic', 20, 'Workstream', '0-15-2', [
      { kind: 'Topic', id: 'topic-uuid', slug: 'selected', relation: 'mutated' },
    ]);
    const unrelated = run('other-topic', 30, 'Workstream', '0-15-2', [
      { kind: 'Topic', id: 'other-uuid', slug: 'other', relation: 'referenced' },
    ]);

    expect(recentRunsForContext([related, unrelated], context).map((item) => item.key)).toEqual(['created-topic']);
  });

  it('matches selected container-app context across canonical kind formatting', () => {
    const appContext = {
      kind: 'container-app',
      routeKind: 'document' as const,
      identifier: 'banking-app',
      title: 'Banking App',
      containerAppId: 'banking-app' as const,
    };
    const older = run('older-app-run', 10, 'ContainerApp', 'banking-app');
    const latest = run('latest-app-run', 20, 'container-app', 'banking-app');
    const other = run('other-app-run', 30, 'container-app', 'sunset-chess');

    expect(recentRunsForContext([latest, other, older], appContext).map((item) => item.key))
      .toEqual(['older-app-run', 'latest-app-run']);
  });

  it('selects exactly the latest five without mutating global history; expansion retains all scoped runs', () => {
    const runs = Array.from({ length: 9 }, (_, index) => run(`run-${index}`, index, 'Topic', 'selected')).reverse();
    runs.push(run('unrelated', 100, 'Topic', 'other'));
    const original = [...runs];
    expect(recentRunsForContext(runs, context).map((item) => item.key))
      .toEqual(['run-4', 'run-5', 'run-6', 'run-7', 'run-8']);
    expect(allRunsForContext(runs, context)).toHaveLength(9);
    expect(runs).toEqual(original);
    expect(runs.some((item) => item.key === 'unrelated')).toBe(true);
    expect(recentRunsForContext(runs, context, 0)).toEqual([]);
  });

  it('orders tied timestamps by stable journal identity regardless of input order', () => {
    const a = run('a', 10, 'Topic', 'selected');
    const b = run('b', 10, 'Topic', 'selected');
    expect(recentRunsForContext([b, a], context)).toEqual([a, b]);
    expect(recentRunsForContext([a, b], context)).toEqual([a, b]);
  });

  it('matches UUID-only refs and canonical kind aliases without matching siblings or other kinds', () => {
    const contextWithId = { ...context, kind: 'topic-type', id: 'uuid' };
    const selected = run('selected', 10, 'TopicType', 'other-slug');
    selected.scope = { kind: 'TopicType', id: 'uuid' };
    const related = run('related', 20, 'Workstream', 'parent', [
      { kind: 'topic-type', id: 'uuid', relation: 'referenced' },
    ]);
    const sibling = run('sibling', 30, 'TopicType', 'selected-child');
    const wrongKind = run('wrong-kind', 40, 'Topic', 'selected');
    expect(allRunsForContext([wrongKind, sibling, related, selected], contextWithId)).toEqual([selected, related]);
  });

  function summary(index: number, selected = true): CommandJournalSummary {
    return {
      id: `persisted-${index}`, resourceVersion: 1, createdAt: index, startedAt: index,
      status: 'succeeded', request: { userText: `Prompt ${index}` },
      primaryScope: { kind: 'Topic', id: selected ? 'selected-id' : 'other-id' },
      entityRefs: [], eventSummaries: [],
    };
  }

  it('paginates beyond both five and the global page size and filters every page by canonical identity', async () => {
    const readPage = vi.fn()
      .mockResolvedValueOnce({ journals: Array.from({ length: 35 }, (_, i) => summary(i, false)), nextCursor: 'older' })
      .mockResolvedValueOnce({ journals: Array.from({ length: 8 }, (_, i) => summary(i + 40)), nextCursor: 'last' })
      .mockResolvedValueOnce({ journals: [summary(50)] });
    const loaded: CommandJournalSummary[] = [];
    await loadScopedHistory({ ...context, id: 'selected-id' }, readPage, () => true, (page) => loaded.push(...page));
    expect(loaded).toHaveLength(9);
    expect(readPage.mock.calls).toEqual([
      [{ limit: 100 }], [{ limit: 100, cursor: 'older' }], [{ limit: 100, cursor: 'last' }],
    ]);
  });

  it('ignores a stale in-flight page after navigation or environment switching and stops pagination', async () => {
    let resolve!: (page: CommandJournalHistoryPage) => void;
    const readPage = vi.fn(() => new Promise<CommandJournalHistoryPage>((done) => { resolve = done; }));
    let current = true;
    const onPage = vi.fn();
    const pending = loadScopedHistory(context, readPage, () => current, onPage);
    current = false;
    resolve({ journals: [summary(1)], nextCursor: 'older' });
    await pending;
    expect(onPage).not.toHaveBeenCalled();
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it('retains earlier pages on errors and rejects non-advancing pagination instead of silently capping history', async () => {
    const onPage = vi.fn();
    const readPage = vi.fn().mockResolvedValueOnce({ journals: [summary(1)], nextCursor: 'older' })
      .mockRejectedValueOnce(new Error('offline'));
    await expect(loadScopedHistory({ ...context, id: 'selected-id' }, readPage, () => true, onPage)).rejects.toThrow('offline');
    expect(onPage.mock.calls[0][0]).toHaveLength(1);
    await expect(loadScopedHistory(context, async () => ({ journals: [], nextCursor: 'same' }),
      () => true, () => {})).rejects.toThrow('did not advance');
  });

  it('does not resurrect a deleted journal from an in-flight page after the load is invalidated', async () => {
    let resolve!: (page: CommandJournalHistoryPage) => void;
    const deleted = summary(1);
    let loaded: CommandJournalSummary[] = [];
    let current = true;
    const readPage = vi.fn()
      .mockResolvedValueOnce({ journals: [deleted], nextCursor: 'older' })
      .mockImplementationOnce(() => new Promise<CommandJournalHistoryPage>((done) => { resolve = done; }));
    const pending = loadScopedHistory({ ...context, id: 'selected-id' }, readPage, () => current,
      (page) => { loaded.push(...page); });
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledTimes(2));
    loaded = loaded.filter((item) => item.id !== deleted.id);
    current = false;
    resolve({ journals: [deleted] });
    await pending;
    expect(loaded).toEqual([]);
  });

  it('does not clobber live status, progress, or confirmations with an equal-version scoped cache', () => {
    const cached = summary(1);
    const live: ChatRun = { ...run(cached.id, 1, 'Topic', 'selected'), journalId: cached.id, resourceVersion: 1,
      status: 'awaiting_confirmation', progress: [{ name: 'write', status: 'completed', summary: 'outcome' }],
      pendingConfirmation: { id: 'confirm', tool: 'write', arguments: {} } };
    expect(mergeScopedHistory([live], [cached])[0]).toEqual(live);
    expect(mergeScopedHistory([live], [{ ...cached, resourceVersion: 2, status: 'cancelled' }])[0].status).toBe('cancelled');
  });

  it('keeps a new live confirmation visible even when its journal version trails an earlier cached page', () => {
    const persisted = { ...summary(1), resourceVersion: 5, status: 'running' as const };
    const live = reconcileLiveRun([summaryToChatRun(persisted)], persisted.id, {
      journalId: persisted.id, status: 'awaiting_confirmation', message: 'Confirm this write',
      pendingConfirmation: { id: 'confirm', tool: 'ws-topic-update', arguments: {} },
    });
    const [merged] = mergeScopedHistory(live, [{ ...persisted, resourceVersion: 6 }]);
    expect(merged.status).toBe('awaiting_confirmation');
    expect(merged.pendingConfirmation?.id).toBe('confirm');
    const hydrated = mergeHistoryRuns(live, [{ ...persisted, resourceVersion: 7, status: 'awaiting_confirmation' }]);
    expect(hydrated[0].unpersistedResult).toBe(false);
  });
});