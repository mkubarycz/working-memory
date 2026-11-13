import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { ControlPlaneClient, type CommandJournal } from '../../shared/controlPlaneClient';
import { openStore } from '../../control-plane/src/store';
import { startServer } from '../../control-plane/src/server';
import { InstanceIdentity } from '../../control-plane/src/instanceIdentity';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { buildChatBugReport, createChatBugReport } from '../src/main/chatBugReport';
import { serializeFeedback } from '../src/main/topicSharing';
import type { ChatBugReportInput } from '../src/shared/contracts';

const cleanup: Array<() => Promise<void>> = [];
beforeAll(() => loadKinds());
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const now = Date.parse('2026-11-13T12:00:00Z');
const environment = { desktopVersion: '1.11.0-dev', desktopBuild: 'fixture-build',
  backendUrl: 'http://127.0.0.1:7717/mcp', platform: 'win32', arch: 'x64', processId: 123 };
const input: ChatBugReportInput = {
  description: 'This has been running for hours and blocks a new message.',
  run: { key: 'visible-run', status: 'running', startedAt: now - 86400000,
    userText: 'Inspect my topic', assistantText: 'Inspecting the resource…',
    scope: { kind: 'Topic', id: 'resource-1', title: 'The selected resource' }, attachments: [] },
  renderer: { conversationBlocked: true, localRequestActive: false },
};
const diagnostics = () => ({ localRun: 'not tracked on this desktop', ownershipNote: 'Another device may still be running.' });
const reportOptions = { environment, secrets: ['PRIVATE_MODEL_KEY'], diagnostics, now: () => now };

it('creates an inspectable report from a real running journal without transitioning or unblocking that run', async () => {
  const store = openStore(':memory:');
  const owner = await new InstanceIdentity(store.db).initialize('private report test password');
  const server = await startServer({ port: 0, store });
  const client = new ControlPlaneClient({ resolveUrl: () => `${server.url}/mcp`, getToken: () => owner.token });
  cleanup.push(async () => { await client.dispose(); await server.close(); store.close(); });
  await client.topicTypeCreate({ label: 'Topic', icon: 'symbol-misc', description: 'Default topic' });
  const created = await client.commandJournalCreate({
    startedAt: input.run.startedAt, request: { userText: input.run.userText },
    primaryScope: input.run.scope, provider: { endpoint: 'copilot://local', mode: 'copilot', model: 'fixture' },
  });
  const eventId = randomUUID();
  const journal = await client.commandJournalAppend({
    id: created.id, expectedResourceVersion: created.resourceVersion, events: [
      { id: eventId, sequence: 1, timestamp: now - 10000, type: 'model_turn', role: 'assistant', iteration: 1,
        assistantText: 'Inspecting', durationMs: 100 },
      { id: randomUUID(), sequence: 2, timestamp: now - 9000, type: 'tool_call',
        modelTurnId: eventId, callId: 'stalled-tool', toolName: 'ws-topic-read', arguments: { id: 'resource-1' } },
    ],
  });
  const dependencies = { ...reportOptions, client, assertCurrent: vi.fn() };
  const report = await createChatBugReport({ ...input, run: { ...input.run, journalId: journal.id } }, dependencies);
  expect(report.body).toContain(journal.id);
  for (const value of ['blocks a new message', 'Inspect my topic', 'Inspecting the resource', 'stalled-tool',
    'ws-topic-read', '"persistedStatus": "running"', '"sinceLastEventMs": 9000', 'not tracked on this desktop', '"platform": "win32"']) {
    expect(report.body).toContain(value);
  }
  expect(await client.commandJournalRead({ id: journal.id })).toEqual(journal);
  expect((await client.topicRead({ id: report.id }))[0].body).toBe(report.body);
  const fetcher = vi.fn<typeof fetch>();
  const serialized = await serializeFeedback(report, server.url, randomUUID(), {
    desktop: { version: environment.desktopVersion, build: environment.desktopBuild }, backend: { version: 'fixture' },
  }, fetcher);
  expect(JSON.parse(serialized).topic.body).toContain('stalled-tool');
  expect(fetcher).not.toHaveBeenCalled();
  const create = vi.spyOn(client, 'topicCreate');
  await expect(createChatBugReport({ ...input, description: ' ' }, dependencies)).rejects.toThrow();
  dependencies.assertCurrent.mockImplementationOnce(() => { throw new Error('Environment changed'); });
  await expect(createChatBugReport(input, dependencies)).rejects.toThrow('Environment changed');
  dependencies.assertCurrent.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('Environment changed during capture'); });
  await expect(createChatBugReport({ ...input, run: { ...input.run, journalId: journal.id } }, dependencies))
    .rejects.toThrow('Environment changed during capture');
  expect(create).not.toHaveBeenCalled();
  await expect(createChatBugReport({ ...input, run: { ...input.run, journalId: randomUUID() } }, dependencies))
    .rejects.toThrow('journal is unavailable');
  expect(create).not.toHaveBeenCalled();
});

it('captures submitting messages and partial evidence without claiming a remote run has stopped', () => {
  const report = buildChatBugReport({ ...input, run: { ...input.run, status: 'submitting' } }, null, reportOptions);
  expect(report.body).toContain('"rendererStatus": "submitting"');
  expect(report.body).toContain('No journal captured');
  expect(report.body).toContain('Another device may still be running');
  expect(report.body).toContain('Inspect my topic');
});

it('redacts known credentials and structured secret fields, and never turns diagnostic attachment references into uploads', () => {
  const report = buildChatBugReport({
    ...input, description: 'Failure with PRIVATE_MODEL_KEY and sk-thisIsASecret123',
    run: { ...input.run, userText: 'Bearer abc123secret\npassword=private-value\nhttps://user:pass@host/path\nBasic c2VjcmV0\nwm-attachment:00000000-0000-4000-8000-000000000001',
      pendingConfirmation: { id: 'confirm', tool: 'test', arguments: { nested: { token: 'private-token' } } } },
  }, null, reportOptions);
  for (const secret of ['PRIVATE_MODEL_KEY', 'sk-thisIsASecret123', 'abc123secret', 'private-value', 'user:pass@', 'c2VjcmV0', 'private-token']) {
    expect(JSON.stringify(report)).not.toContain(secret);
  }
  expect(report.body).not.toContain('wm-attachment:');
  expect(report.body).toContain('wm-attachment (reference):');
});

it('retains the newest tool evidence within the exact feedback budget and labels omissions and truncation', () => {
  const events: CommandJournal['events'] = Array.from({ length: 300 }, (_, i) => ({
    id: `result-${i}`, sequence: i + 1, timestamp: now - 300 + i, type: 'tool_result', callId: `call-${i}`,
    status: 'success', result: { body: 'x'.repeat(65000), rows: Array(500).fill({ value: 'sample' }) }, durationMs: 1,
  }));
  const journal: CommandJournal = {
    id: 'journal', schemaVersion: 2, resourceVersion: 1, status: 'running', createdAt: 0, updatedAt: 0,
    startedAt: input.run.startedAt, provider: { endpoint: 'copilot://local', mode: 'copilot', model: 'fixture' },
    request: { userText: input.run.userText }, primaryScope: input.run.scope, entityRefs: [], events,
  };
  const report = buildChatBugReport(input, journal, reportOptions);
  expect(report.body.length).toBeLessThanOrEqual(900000);
  expect(report.body).toContain('Event 300: tool_result');
  expect(report.body).not.toContain('Event 1: tool_result');
  expect(report.body).toContain('older events omitted');
  expect(report.body).toContain('Evidence truncated');
  const maximum = buildChatBugReport({
    ...input, run: { ...input.run, userText: '\n'.repeat(29000), assistantText: '\n'.repeat(29000) },
  }, journal, reportOptions);
  expect(maximum.body.length).toBeLessThanOrEqual(900000);
  const included = Number(maximum.body.match(/Showing the latest (\d+)/)?.[1]);
  expect(included).toBeGreaterThan(0);
  expect(included).toBeLessThan(100);
  expect(maximum.body).toContain('Event 300: tool_result');
  journal.events.push({
    id: 'hidden', sequence: 301, timestamp: now, type: 'model_turn', role: 'assistant', iteration: 2, durationMs: 1,
    contentParts: [{ type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'text', text: 'Visible text' }],
  }, {
    id: 'system', sequence: 302, timestamp: now, type: 'model_turn', role: 'system', iteration: 2, durationMs: 1,
    assistantText: 'PRIVATE_SYSTEM_PROMPT',
  });
  const filtered = buildChatBugReport({ ...input, run: { ...input.run, assistantText: undefined } }, journal, reportOptions);
  expect(filtered.body).toContain('Visible text');
  expect(filtered.body).not.toContain('PRIVATE_REASONING');
  expect(filtered.body).not.toContain('PRIVATE_SYSTEM_PROMPT');
  expect(filtered.body).toContain('1 internal system events excluded');
});
