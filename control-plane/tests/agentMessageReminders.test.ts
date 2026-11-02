import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStore, type DocumentEnvelope, type Store } from '../src/store';
import { loadKinds } from '../src/kinds/loader';
import { activateDueReminders, DUE_REMINDERS_SQL } from '../src/agentMessageReminders';
import { instanceToolPermissions } from '../src/instanceAuthorization';
import { ControlPlaneClient, startServer } from '../../tests/authenticatedFixture';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stores: Store[] = [];
const now = 1_793_500_000;
const body = '# Reminder\r\n\nReview **X, Y, Z**.';
beforeAll(async () => { await loadKinds(); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

function fixture(filename = ':memory:') {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now * 1000);
  const store = openStore(filename);
  stores.push(store);
  const agent = store.createDocument({ kind: 'Agent', spec: { name: 'Reminder Tests' } });
  const spec = {
    agent_id: agent.metadata.id, title: 'Review X, Y, Z', description: body,
    category: 'reminder', due_at: now + 30, recommended_action: 'Review X, Y, Z.',
  };
  const create = (extra: Record<string, unknown> = {}) =>
    store.createDocument({ kind: 'AgentMessage', spec: { ...spec, ...extra } });
  const update = (document: DocumentEnvelope, extra: Record<string, unknown>) =>
    store.updateDocument({ id: document.metadata.id, expectedResourceVersion: document.metadata.resourceVersion,
      spec: { ...document.spec, ...extra } });
  return { clock, store, spec, create, update };
}

describe('durable AgentMessage reminders', () => {
  it('requires a reminder-only valid deadline and an actionable recommendation', () => {
    const { create } = fixture();
    for (const extra of [
      { due_at: undefined }, { due_at: 0 }, { due_at: -1 }, { due_at: 1.5 }, { due_at: 'tomorrow' },
      { due_at: 8_640_000_000_001 }, { recommended_action: ' ' }, { category: 'request' },
    ]) expect(() => create(extra)).toThrow();
    expect(create({ attention: true }).spec).toMatchObject({ attention: false, severity: 'info' });
  });

  it('activates exactly at the deadline, publishes one change, and remains idempotent', () => {
    const { clock, store, create } = fixture();
    const original = create();
    const changes = vi.fn();
    const unsubscribe = store.onDocumentsChanged(changes);
    clock.mockReturnValue((now + 29) * 1000 + 999);
    expect(activateDueReminders(store)).toBe(0);
    clock.mockReturnValue((now + 30) * 1000);
    expect(activateDueReminders(store)).toBe(1);
    const due = store.getDocument({ id: original.metadata.id })!;
    expect(due.spec).toMatchObject({ attention: true, category: 'reminder', severity: 'info', description: body });
    expect(due.metadata.createdAt).toBe(original.metadata.createdAt);
    expect(changes).toHaveBeenCalledTimes(1);
    const version = store.getResourceVersion();
    expect(activateDueReminders(store)).toBe(0);
    expect(store.getResourceVersion()).toBe(version);
    expect(store.listDocuments({ kind: 'AgentMessage' })).toHaveLength(1);
    unsubscribe();
  });

  it('acknowledgement and resolution suppress attention until explicitly reopened', () => {
    const { clock, store, create, update } = fixture();
    let reminder = create();
    clock.mockReturnValue((now + 60) * 1000);
    for (const status of ['acknowledged', 'resolved']) {
      reminder = update(reminder, { status, attention: true });
      expect(reminder.spec.attention).toBe(false);
      expect(activateDueReminders(store)).toBe(0);
      reminder = update(reminder, { status: 'open', attention: false });
      expect(reminder.spec.attention).toBe(true);
    }
  });

  it('searches only the partial pending-deadline index and keeps membership current', () => {
    const { clock, store, create, update } = fixture();
    const due = create({ due_at: now + 1 });
    const future = create({ due_at: now + 60 });
    create({ due_at: now, attention: true });
    create({ status: 'acknowledged' });
    create({ status: 'resolved' });
    const deleted = create();
    store.deleteDocument({ id: deleted.metadata.id });
    for (let index = 0; index < 100; index++) create({ category: 'completion', due_at: undefined, status: 'resolved' });
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${DUE_REMINDERS_SQL}`).all(now + 2);
    expect(plan.map((row) => row.detail).join('\n'))
      .toContain('SEARCH resources USING INDEX idx_agent_message_pending_deadline');
    const pending = () => store.db.prepare(DUE_REMINDERS_SQL).all(now + 3600).map((row) => row.id).sort();
    expect(pending()).toEqual([due.metadata.id, future.metadata.id].sort());
    clock.mockReturnValue((now + 2) * 1000);
    expect(activateDueReminders(store)).toBe(1);
    expect(pending()).toEqual([future.metadata.id]);
    const acknowledged = update(future, { status: 'acknowledged' });
    expect(pending()).toEqual([]);
    update(acknowledged, { status: 'open' });
    expect(pending()).toEqual([future.metadata.id]);
  });

  it('rescheduling clears attention, never fires the old deadline, and preserves identity and source', () => {
    const { clock, store, create, update } = fixture();
    const original = create({ due_at: now });
    expect(original.spec.attention).toBe(true);
    const scheduled = update(original, { due_at: now + 120 });
    expect(scheduled.spec.attention).toBe(false);
    clock.mockReturnValue((now + 60) * 1000);
    expect(activateDueReminders(store)).toBe(0);
    clock.mockReturnValue((now + 120) * 1000);
    expect(activateDueReminders(store)).toBe(1);
    const due = store.getDocument({ id: original.metadata.id })!;
    expect(due.spec).toMatchObject({ description: body, agent_id: original.spec.agent_id, attention: true });
    expect(store.listDocuments({ kind: 'AgentMessage' })).toHaveLength(1);
  });

  it('does not activate deleted reminders and restores their current deadline state', () => {
    const { clock, store, create } = fixture();
    const reminder = create();
    store.deleteDocument({ id: reminder.metadata.id });
    clock.mockReturnValue((now + 60) * 1000);
    expect(activateDueReminders(store)).toBe(0);
    expect(store.restoreDocument({ id: reminder.metadata.id }).spec.attention).toBe(true);
    expect(activateDueReminders(store)).toBe(0);
  });

  it('preserves active retry identity and rejects conflicting deadlines', () => {
    const { create } = fixture();
    const reminder = create({ dedupe_key: 'review-reminder' });
    expect(create({ dedupe_key: 'review-reminder' })).toEqual(reminder);
    expect(() => create({ dedupe_key: 'review-reminder', due_at: now + 60 })).toThrow(/conflicts/);
  });

  it('retains its deadline through a real SQLite close/reopen and catches up without rewriting authored content', () => {
    const directory = mkdtempSync(join(tmpdir(), 'working-memory-reminder-store-'));
    const filename = join(directory, 'store.db');
    const { clock, store, create } = fixture(filename);
    const original = create();
    store.db.exec('DROP INDEX idx_agent_message_pending_deadline');
    store.close();
    stores.pop();
    try {
      clock.mockReturnValue((now + 60) * 1000);
      const reopened = openStore(filename);
      try {
        expect(reopened.db.prepare(`EXPLAIN QUERY PLAN ${DUE_REMINDERS_SQL}`).all(now + 60)
          .map((row) => row.detail).join('\n'))
          .toContain('SEARCH resources USING INDEX idx_agent_message_pending_deadline');
        expect(activateDueReminders(reopened)).toBe(1);
        const reminder = reopened.getDocument({ id: original.metadata.id })!;
        expect(reminder.spec).toMatchObject({ due_at: now + 30, attention: true, description: body });
        expect(reminder.metadata.id).toBe(original.metadata.id);
        expect(reminder.metadata.createdAt).toBe(original.metadata.createdAt);
      } finally { reopened.close(); }
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('applies reminder attention invariants to generic batch writes', () => {
    const { store, create } = fixture();
    const original = create();
    const [due] = store.updateDocuments([{ id: original.metadata.id,
      expectedResourceVersion: original.metadata.resourceVersion, spec: { ...original.spec, due_at: now } }]);
    expect(due.spec.attention).toBe(true);
    const [acknowledged] = store.updateDocuments([{ id: due.metadata.id,
      expectedResourceVersion: due.metadata.resourceVersion, spec: { ...due.spec, status: 'acknowledged' } }]);
    expect(acknowledged.spec.attention).toBe(false);
  });

  it('catches up on backend startup and activates future reminders without desktop clients', async () => {
    const { clock, store, create } = fixture();
    const missed = create();
    const future = create({ due_at: now + 120 });
    clock.mockReturnValue((now + 60) * 1000);
    const server = await startServer({ store, port: 0 });
    try {
      expect(store.getDocument({ id: missed.metadata.id })!.spec.attention).toBe(true);
      clock.mockReturnValue((now + 120) * 1000);
      await vi.waitFor(() => expect(store.getDocument({ id: future.metadata.id })!.spec.attention).toBe(true),
        { timeout: 2000 });
    } finally { await server.close(); }
  });

  it('snoozes through authenticated MCP using CAS and leaves topic lifecycle unchanged', async () => {
    const { store } = fixture();
    const server = await startServer({ store, port: 0 });
    const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp` });
    try {
      const agent = await client.agentCreate({ name: 'Snooze Agent' });
      await client.topicTypeCreate({ label: 'Topic', icon: 'notebook', description: 'Default' });
      const topic = await client.topicCreate({ title: 'User-owned reminder scope' });
      const reminder = await client.agentMessageCreate({ agent_id: agent.id,
        title: 'Review', description: body, recommended_action: 'Review this topic.',
        category: 'reminder', due_at: now, topics: [topic.id] });
      expect(reminder.attention).toBe(true);
      const acknowledged = await client.agentMessageUpdate({ id: reminder.id, status: 'acknowledged' });
      const snoozed = await client.agentMessageSnooze({ id: reminder.id, due_at: now + 1800,
        expectedResourceVersion: acknowledged.resourceVersion });
      expect(snoozed).toMatchObject({ id: reminder.id, due_at: now + 1800, status: 'open', attention: false, description: body });
      await expect(client.agentMessageSnooze({ id: reminder.id, due_at: now + 3600,
        expectedResourceVersion: acknowledged.resourceVersion })).rejects.toThrow(/Conflict/);
      await expect(client.agentMessageSnooze({ id: reminder.id, due_at: now })).rejects.toThrow(/future/);
      const ordinary = await client.agentMessageCreate({ agent_id: agent.id, title: 'Done',
        description: 'Completed', category: 'completion' });
      await expect(client.agentMessageSnooze({ id: ordinary.id, due_at: now + 60 })).rejects.toThrow(/reminder/);
      expect((await client.topicRead({ id: topic.id }))[0].status).toBe('open');
      expect(instanceToolPermissions('ws-agent-message-snooze', { id: reminder.id }, store))
        .toEqual([{ category: 'content', operation: 'update' }]);
    } finally { await client.dispose(); await server.close(); }
  });
});
