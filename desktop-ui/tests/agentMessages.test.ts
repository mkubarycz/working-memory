import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { activeReminderRows, customReminderDeadline, loadAllAgentMessages, mergeMessageRows, messageNeedsAttention, messagesForContext, messageStatusActions, presetReminderDeadline, reminderTiming, snoozeDeadline } from '../src/renderer/agentMessages';
import type { AgentMessageVM, WorkstreamVM } from '../src/renderer/documents/types';
import type { ChatRun } from '../src/renderer/chatHistory';
import { targetForRef, toolMode } from '../src/renderer/chatHistory';

function message(index: number, extra: Partial<AgentMessageVM> = {}): AgentMessageVM {
  return { id: `message-${index}`, agentId: 'agent-1', agentName: 'Review Agent', title: `Message ${index}`, description: 'Body', recommendedAction: '',
    status: 'open', category: 'completion', severity: 'info', attention: false,
    topics: ['topic-uuid'], relations: [], createdAt: index, updatedAt: index, ...extra };
}
const context = { kind: 'topic', routeKind: 'topic' as const, identifier: 'topic-uuid', title: 'Topic' };

describe('canonical agent message timeline', () => {
  it('shows deadline timing at the exact second boundary and suppresses overdue styling after acknowledgement/resolution', () => {
    const reminder = message(0, { category: 'reminder', dueAt: 1000 });
    expect(reminderTiming(reminder, 940_000)).toEqual({ text: 'Due in 1 minute', overdue: false });
    expect(reminderTiming(reminder, 1000_000)).toEqual({ text: 'Due now', overdue: true });
    expect(reminderTiming(reminder, 1060_000)).toEqual({ text: 'Due 1 minute ago', overdue: true });
    expect(reminderTiming({ ...reminder, status: 'acknowledged' }, 1060_000)).toEqual({ text: 'Acknowledged', overdue: false });
    expect(reminderTiming({ ...reminder, status: 'resolved' }, 1060_000)).toEqual({ text: 'Resolved', overdue: false });
    expect(reminderTiming(message(0))).toBeNull();
    expect(() => reminderTiming({ ...reminder, dueAt: undefined })).toThrow(/deadline/);
  });

  it('keeps open reminders discoverable in deadline order without including acknowledged/resolved history', () => {
    const rows = mergeMessageRows([], [
      message(1, { category: 'reminder', dueAt: 2000 }),
      message(2, { category: 'reminder', dueAt: 1000 }),
      message(3, { category: 'reminder', dueAt: 500, status: 'acknowledged' }),
      message(4, { category: 'reminder', dueAt: 100, status: 'resolved' }),
      message(5),
    ]);
    expect(activeReminderRows(rows).map((row) => row.message.id)).toEqual(['message-2', 'message-1']);
    expect(rows).toHaveLength(5);
  });

  it('computes preset and custom snooze deadlines in seconds and explicitly rejects invalid input', () => {
    expect(snoozeDeadline(30, 1_000_999)).toBe(2800);
    expect(customReminderDeadline('2026-10-31T20:00:00Z', Date.parse('2026-10-31T19:00:00Z')))
      .toBe(Date.parse('2026-10-31T20:00:00Z') / 1000);
    expect(() => snoozeDeadline(0)).toThrow(/positive/);
    expect(() => customReminderDeadline('invalid')).toThrow(/date and time/);
    expect(() => customReminderDeadline('2020-01-01T00:00:00Z')).toThrow(/future/);
  });

  it('parses natural-language custom times locally and rejects past, ambiguous, or missing times', () => {
    const now = new Date(2026, 10, 1, 21, 15, 20).getTime();
    expect(customReminderDeadline('in 45 minutes', now)).toBe(Math.floor(now / 1000) + 45 * 60);
    expect(customReminderDeadline('  in 45 minutes \n', now)).toBe(Math.floor(now / 1000) + 45 * 60);
    expect(customReminderDeadline('tomorrow at 9am', now)).toBe(new Date(2026, 10, 2, 9).getTime() / 1000);
    expect(customReminderDeadline('Friday at 2pm', now)).toBe(new Date(2026, 10, 6, 14).getTime() / 1000);
    expect(customReminderDeadline('9am', now)).toBe(new Date(2026, 10, 2, 9).getTime() / 1000);
    expect(() => customReminderDeadline('yesterday', now)).toThrow(/future/);
    expect(() => customReminderDeadline('tomorrow or Friday', now)).toThrow(/one date/);
    expect(() => customReminderDeadline('from 2pm to 3pm', now)).toThrow(/range/);
    expect(() => customReminderDeadline('', now)).toThrow(/Enter a time/);
    expect(() => customReminderDeadline('no date here', now)).toThrow(/date and time/);
    expect(() => customReminderDeadline('x'.repeat(501), now)).toThrow(/Enter a time/);
  });

  it.each([
    'tomorrow at 25:00',
    'tomorrow at 09:99',
    'every day at 9am',
    'every Friday at 2pm',
    'garbage tomorrow',
    'in 45 minutes garbage',
    'remind me in an hour',
  ])('rejects partially understood custom snooze input: %s', (value) => {
    const now = new Date(2026, 10, 1, 21, 15, 20).getTime();
    expect(() => customReminderDeadline(value, now)).toThrow(/entire time expression.*one-time/);
  });

  it('schedules Tomorrow at 9 AM and Next week at 9 AM on the next Monday', () => {
    const now = new Date(2026, 10, 1, 21, 15, 20, 999).getTime();
    expect(presetReminderDeadline('10-minutes', now)).toBe(Math.floor(now / 1000) + 600);
    expect(presetReminderDeadline('1-hour', now)).toBe(Math.floor(now / 1000) + 3600);
    expect(presetReminderDeadline('tomorrow', now)).toBe(new Date(2026, 10, 2, 9).getTime() / 1000);
    expect(presetReminderDeadline('next-week', now)).toBe(new Date(2026, 10, 2, 9).getTime() / 1000);
    for (const day of [2, 3, 5, 8]) {
      expect(presetReminderDeadline('next-week', new Date(2026, 10, day, 8).getTime()))
        .toBe(new Date(2026, 10, 9, 9).getTime() / 1000);
    }
    expect(presetReminderDeadline('tomorrow', new Date(2026, 11, 31, 23).getTime()))
      .toBe(new Date(2027, 0, 1, 9).getTime() / 1000);
  });

  it('uses local calendar time across daylight-saving changes, not fixed 24-hour days', () => {
    vi.stubEnv('TZ', 'America/New_York');
    try {
      const spring = new Date(2027, 2, 13, 9).getTime();
      const fall = new Date(2027, 10, 6, 9).getTime();
      expect(presetReminderDeadline('tomorrow', spring) * 1000 - spring).toBe(23 * 3600_000);
      expect(presetReminderDeadline('tomorrow', fall) * 1000 - fall).toBe(25 * 3600_000);
      expect(presetReminderDeadline('next-week', spring)).toBe(new Date(2027, 2, 15, 9).getTime() / 1000);
      expect(presetReminderDeadline('next-week', fall)).toBe(new Date(2027, 10, 8, 9).getTime() / 1000);
    } finally { vi.unstubAllEnvs(); }
  });

  it('declares the message refresh function in App script scope for startup and live-update callers', () => {
    const app = readFileSync(new URL('../src/renderer/App.svelte', import.meta.url), 'utf8');
    const script = app.slice(app.indexOf('>') + 1, app.indexOf('</script>'));
    const source = ts.createSourceFile('App.ts', script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const topLevel = source.statements.filter(ts.isFunctionDeclaration);
    expect(topLevel.filter((node) => node.name?.text === 'refreshAgentMessages')).toHaveLength(1);
    const initializer = topLevel.find((node) => node.name?.text === 'initializeWorkspace');
    expect(initializer?.getText(source)).toContain('refreshInstanceConnection()');
    expect(initializer?.getText(source)).toContain('loadAuthenticatedWorkspace()');
    const authenticated = topLevel.find((node) => node.name?.text === 'loadAuthenticatedWorkspace');
    expect(authenticated?.getText(source)).toContain('refreshAgentMessages()');
    const latest = topLevel.find((node) => node.name?.text === 'refreshLatestHistory');
    expect(latest?.getText(source)).not.toContain('function refreshAgentMessages');
    const onChanges = topLevel.find((node) => node.name?.text === 'handleDocumentChanges')?.getText(source) ?? '';
    expect(onChanges).toContain('agentMessagesRequest += 1');
    expect(onChanges.indexOf('agentMessagesRequest += 1')).toBeLessThan(onChanges.indexOf('documentChanges.enqueue'));
    expect(onChanges).toContain('entry.deleted && entry.id === message.id');
  });
  it('opens canonical message refs natively while retaining historical alert adapters and write disclosures', () => {
    expect(targetForRef({ kind: 'AgentMessage', id: 'message-id' })).toEqual({ kind: 'agent-message', identifier: 'message-id' });
    expect(targetForRef({ kind: 'agent-message', id: 'message-id' })).toEqual({ kind: 'agent-message', identifier: 'message-id' });
    expect(targetForRef({ kind: 'Alert', id: 'historical' })).toEqual({ kind: 'alert', identifier: 'historical' });
    expect(toolMode('ws-agent-message-restore')).toBe('write');
    expect(toolMode('ws-agent-message-read')).toBe('read');
  });
  it('offers message-only lifecycle actions, including explicit reopen for every retained historical state', () => {
    expect(messageStatusActions('open')).toEqual([
      { label: 'Acknowledge', status: 'acknowledged' }, { label: 'Resolve', status: 'resolved' },
    ]);
    expect(messageStatusActions('acknowledged')).toEqual([
      { label: 'Resolve', status: 'resolved' }, { label: 'Reopen', status: 'open' },
    ]);
    expect(messageStatusActions('resolved')).toEqual([{ label: 'Reopen', status: 'open' }]);
  });
  it('merges more than five messages chronologically with stable disjoint keys and retains lifecycle history', () => {
    const run = { key: 'message-2', startedAt: 2000 } as ChatRun;
    const messages = Array.from({ length: 8 }, (_, index) => message(index));
    messages[1].status = 'acknowledged';
    messages[2].status = 'resolved';
    const rows = mergeMessageRows([run], [...messages].reverse());
    expect(rows).toHaveLength(9);
    expect(rows.map((row) => row.timestamp)).toEqual([0, 1000, 2000, 2000, 3000, 4000, 5000, 6000, 7000]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(9);
    expect(rows.slice(-5).map((row) => row.timestamp)).toEqual([3000, 4000, 5000, 6000, 7000]);
    const changed = message(2, { status: 'resolved', description: 'Changed', updatedAt: 1000 });
    expect(mergeMessageRows([], [changed])[0].timestamp).toBe(2000);
    expect(mergeMessageRows([], messages.filter((item) => item.id !== 'message-2'))).toHaveLength(7);
  });

  it('normalizes epoch-second documents against epoch-millisecond chat runs', () => {
    const seconds = 1_792_540_000;
    const rows = mergeMessageRows([
      { key: 'before', startedAt: seconds * 1000 - 1 } as ChatRun,
      { key: 'after', startedAt: seconds * 1000 + 1 } as ChatRun,
    ], [message(0, { createdAt: seconds })]);
    expect(rows.map((row) => row.key)).toEqual(['run:before', 'agent-message:message-0', 'run:after']);
  });

  it('matches canonical IDs and direct relations, and workstream member topic ids without cross-kind leakage', () => {
    const messages = [
      message(0), message(1, { topics: ['topic-uuid'] }),
      message(2, { topics: [], relations: [{ kind: 'Topic', id: 'topic-uuid' }] }),
      message(3, { topics: [], relations: [{ kind: 'Workstream', id: 'topic-uuid' }] }),
      message(4, { topics: ['other'] }),
    ];
    expect(messagesForContext(messages, context).map((item) => item.id)).toEqual(['message-0', 'message-1', 'message-2']);
    const workstream = { kind: 'workstream', topics: [{ id: 'topic-uuid',  }], tree: [
      { children: [{ id: 'synthetic-ui-id', documentId: 'topic-uuid',  children: [] }] },
    ] } as unknown as WorkstreamVM;
    expect(messagesForContext(messages, { ...context, kind: 'Workstream', identifier: 'ws' }, workstream))
      .toHaveLength(3);
    expect(messagesForContext([message(5, { topics: ['synthetic-ui-id'] })],
      { ...context, kind: 'Workstream', identifier: 'ws' }, workstream)).toEqual([]);
    expect(messagesForContext(messages, undefined)).toEqual([]);
    const missingIdentity = { kind: 'workstream', topics: [{ id: '' }], tree: [
      { children: [{ id: '',  children: [] }] },
    ] } as unknown as WorkstreamVM;
    expect(messagesForContext([
      message(5, { topics: [''], relations: [{ kind: 'Workstream', id: '' }] }),
    ], { ...context, kind: 'Workstream', identifier: '' }, missingIdentity)).toEqual([]);
  });

  it('loads all independent pages, including older attention, and counts only open attention messages', async () => {
    const all = Array.from({ length: 205 }, (_, index) => message(index, {
      attention: index === 200 || index === 201, status: index === 201 ? 'resolved' : 'open',
    }));
    const loaded: AgentMessageVM[] = [];
    const offsets: number[] = [];
    await loadAllAgentMessages(async ({ limit, offset }) => {
      offsets.push(offset); return all.slice(offset, offset + limit);
    }, () => true, (page) => loaded.push(...page));
    expect(offsets).toEqual([0, 100, 200]);
    expect(loaded).toHaveLength(205);
    expect(loaded.filter(messageNeedsAttention).map((item) => item.id)).toEqual(['message-200']);
    expect(messageNeedsAttention(message(1, { status: 'acknowledged', attention: true }))).toBe(false);
  });

  it('rejects repeated pages and guards stale environment completion before publishing', async () => {
    const page = Array.from({ length: 100 }, (_, index) => message(index));
    await expect(loadAllAgentMessages(async () => page, () => true, () => {})).rejects.toThrow('did not advance');
    let current = true;
    const published: AgentMessageVM[] = [];
    await loadAllAgentMessages(async () => { current = false; return page; }, () => current,
      (items) => published.push(...items));
    expect(published).toEqual([]);
  });

  it('isolates status actions from trusted confirmations and refreshes deletions with generation guards', () => {
    const app = readFileSync(new URL('../src/renderer/App.svelte', import.meta.url), 'utf8');
    const card = readFileSync(new URL('../src/renderer/documents/AgentMessageCard.svelte', import.meta.url), 'utf8');
    const action = app.slice(app.indexOf('async function setAgentMessageStatus'), app.indexOf('function togglePin'));
    expect(action).toContain('window.workingMemory.setAgentMessageStatus(id, status)');
    expect(action).toContain('generation !== environmentGeneration');
    expect(action).not.toMatch(/resolveConfirmation|saveTopic|invokeAction|pendingConfirmation/);
    expect(card).toContain('working-memory://open/agent-message/');
    expect(card).not.toMatch(/onResolve|pendingConfirmation|eval\(|JSON.parse/);
    expect(card).toContain('not authorization');
    expect(card).toContain('!decidedBy.trim()');
    expect(card).toContain('onRecordDecision(message.id, outcome, decidedBy.trim())');
    const decisionAction = app.slice(app.indexOf('async function recordAgentMessageDecision'), app.indexOf('function togglePin'));
    expect(decisionAction).toContain('window.workingMemory.recordAgentMessageDecision(id, { outcome, decided_by:');
    expect(decisionAction).toContain('generation !== environmentGeneration');
    expect(decisionAction).not.toMatch(/resolveConfirmation|saveTopic|invokeAction|pendingConfirmation|decided_at/);
    expect(app).toContain('entry.deleted && entry.id === message.id');
    expect(app).toContain('<MessageTimeline runs={chatRuns} {agentMessages} attachRunIds');
    expect(app).toContain('let scopePreviewExpanded = $state(false)');
  });
});
