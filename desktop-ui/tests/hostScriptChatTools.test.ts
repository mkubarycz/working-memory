import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DesktopChatAgent } from '../src/main/desktopChatAgent';
import { createHostScriptChatTools, type HostScriptChatService } from '../src/main/hostScriptChatTools';
import { executeHostScript } from '../src/main/hostScriptRunner';
import { scriptDefinitionSchema, scriptDefinitionHash, validateScriptArguments, type ScriptDetails, type ScriptJob } from '../../control-plane/src/hostScriptPolicy';
import type { CommandJournal } from '../../shared/controlPlaneClient';
import { commandJournalSpec } from '../../control-plane/src/kinds/commandjournal';

function fixture() {
  const definition = scriptDefinitionSchema.parse({
    name: 'Greeting', description: 'Harmless test', hostId: randomUUID(), timeoutMs: 1000,
    source: 'module.exports = p => ({ greeting: p.name });',
    parameters: { name: { type: 'string', required: true, maxLength: 80 } },
  });
  const details: ScriptDetails = {
    task: { ...definition, id: randomUUID(), definitionHash: scriptDefinitionHash(definition), createdAt: 1,
      revokedAt: null, publishedVersion: 1, latestVersion: 1 },
    versions: [{ version: 1, definition, definitionHash: scriptDefinitionHash(definition), createdAt: 1 }],
  };
  const read = vi.fn(async () => structuredClone(details));
  const save = vi.fn<HostScriptChatService['save']>(async (definition, expectedLatestVersion) => {
    if (expectedLatestVersion !== details.task.latestVersion) throw new Error('Task drafts changed');
    const version = { version: details.task.latestVersion + 1, definition,
      definitionHash: scriptDefinitionHash(definition), createdAt: Date.now() };
    details.versions.unshift(version);
    details.task.latestVersion = version.version;
    return structuredClone(version);
  });
  const test = vi.fn<HostScriptChatService['test']>(async (number, parameters, signal) => {
    const version = details.versions.find(version => version.version === number)!;
    let outcome: { resultJson?: string; error?: string };
    try {
      outcome = await executeHostScript({ jobId: randomUUID(), leaseToken: randomBytes(32).toString('hex'),
        definition: version.definition, definitionHash: version.definitionHash,
        parameters: validateScriptArguments(version.definition.parameters, parameters), deadline: Date.now() + 5000 }, signal);
    } catch (cause) { outcome = { error: cause instanceof Error ? cause.message : String(cause) }; }
    const job: ScriptJob = { id: randomUUID(), taskId: details.task.id, version: number, appId: null,
      state: outcome.error ? 'failed' : 'succeeded', createdAt: Date.now(), expiresAt: Date.now() + 300000,
      resultJson: outcome.resultJson ?? null, error: outcome.error ?? null };
    return job;
  });
  const tools = createHostScriptChatTools({ read, save, test }, details.task.id, 1);
  return { details, definition, read, save, test, tools };
}

function journal() {
  let current: CommandJournal;
  return {
    create: vi.fn(async input => {
      current = { id: randomUUID(), resourceVersion: 1, createdAt: input.startedAt, updatedAt: input.startedAt,
        schemaVersion: 2, status: 'running', ...input, entityRefs: input.entityRefs ?? [], events: [] };
      return current;
    }),
    append: vi.fn(async input => {
      current = { ...current, resourceVersion: current.resourceVersion + 1,
        events: [...current.events, ...input.events], entityRefs: [...current.entityRefs, ...(input.entityRefs ?? [])] };
      return current;
    }),
    finalize: vi.fn(async input => {
      current = { ...current, ...input, resourceVersion: current.resourceVersion + 1 };
      return current;
    }),
    current: () => current,
  };
}
const turn = (...calls: Array<[string, Record<string, unknown>]>) => ({ choices: [{ message: {
  content: null, tool_calls: calls.map(([name, args], index) => ({ id: `${name}-${index}`, function: { name, arguments: JSON.stringify(args) } })),
} }] });
const done = { choices: [{ message: { content: 'Finished.' } }] };
const input = { mode: 'chat-completions' as const, url: 'https://model.test', model: 'test', headers: {},
  message: 'Make this greeting say Hi, then test it.' };

describe('host task scoped chat tools', () => {
  it('reads the pinned version and saves code/parameter edits only as drafts', async () => {
    const { tools, details, save, test } = fixture();
    expect(tools.tools.map(tool => tool.name)).toEqual(['desktop-host-task-read', 'desktop-host-task-update', 'desktop-host-task-test-run']);
    expect(await tools.callTool('desktop-host-task-read', {})).toMatchObject({
      ok: true, result: { taskId: details.task.id, version: 1, publishedVersion: 1, exampleInput: { name: 'World' } },
    });
    expect(await tools.callTool('desktop-host-task-update', {
      baseVersion: 1, expectedLatestVersion: 1, source: 'module.exports = p => ({ greeting: "Hi " + p.name });',
      name: 'Updated greeting', description: 'Edited in chat', timeoutMs: 2000,
      parameters: { name: { type: 'string', required: true, maxLength: 20, enum: ['Ada'] } },
    })).toMatchObject({ ok: true, result: { version: 2, publishedVersion: 1, exampleInput: { name: 'Ada' } } });
    expect(save).toHaveBeenCalledOnce();
    expect(details.versions[0].definition.hostId).toBe(details.task.hostId);
    expect(details.versions[0].definition).toMatchObject({ name: 'Updated greeting', description: 'Edited in chat', timeoutMs: 2000 });
    expect(details.task.publishedVersion).toBe(1);
    expect(await tools.callTool('desktop-host-task-read', {})).toMatchObject({ result: { version: 2, title: 'Updated greeting', description: 'Edited in chat' } });
    expect(await tools.callTool('desktop-host-task-read', { version: 1 })).toMatchObject({ result: { version: 1 } });
    expect(await tools.callTool('desktop-host-task-update', { baseVersion: 1, expectedLatestVersion: 1, source: 'changed' }))
      .toMatchObject({ ok: false, error: 'Task drafts changed' });
    expect(await tools.callTool('desktop-host-task-read', { taskId: randomUUID() })).toMatchObject({ ok: false });
    expect(await tools.callTool('desktop-host-task-publish', {})).toMatchObject({ ok: false });
    expect(test).not.toHaveBeenCalled();
  });

  it('executes actual approved bytes, rejects mismatched hashes, and returns real script errors', async () => {
    const { tools, details, test } = fixture();
    const request = { version: 1, definitionHash: details.task.definitionHash, parameters: { name: 'Ada' } };
    expect(await tools.callTool('desktop-host-task-test-run', { ...request, definitionHash: '0'.repeat(64) })).toMatchObject({ ok: false });
    expect(await tools.callTool('desktop-host-task-test-run', { ...request, parameters: { command: 'not allowed' } })).toMatchObject({ ok: false });
    expect(test).not.toHaveBeenCalled();
    expect(await tools.callTool('desktop-host-task-test-run', request)).toMatchObject({
      ok: true, result: { version: 1, state: 'succeeded', result: { greeting: 'Ada' }, error: null },
    });
    await tools.callTool('desktop-host-task-update', { baseVersion: 1, expectedLatestVersion: 1,
      source: 'module.exports = () => { throw new Error("Test really failed"); };' });
    expect(await tools.callTool('desktop-host-task-test-run', {
      ...request, version: 2, definitionHash: details.versions[0].definitionHash,
    })).toMatchObject({ result: { state: 'failed', result: null, error: 'Test really failed' } });
  });

  it('iterates through read/edit/read, then waits for chat approval before running the draft', async () => {
    const { tools, details, definition, test } = fixture();
    const source = 'module.exports = p => ({ greeting: "Hi " + p.name });';
    const callModel = vi.fn()
      .mockResolvedValueOnce(turn(['desktop-host-task-read', {}]))
      .mockResolvedValueOnce(turn(['desktop-host-task-update', { baseVersion: 1, expectedLatestVersion: 1, source }]))
      .mockResolvedValueOnce(turn(['desktop-host-task-read', {}]))
      .mockResolvedValueOnce(turn(['desktop-host-task-test-run', {
        version: 2, definitionHash: scriptDefinitionHash({ ...definition, source }), parameters: { name: 'Ada' },
      }]))
      .mockResolvedValueOnce(done);
    const history = journal();
    const agent = new DesktopChatAgent({ listTools: async () => [], callTool: vi.fn(), callModel, journal: history });
    const context = { kind: 'host-task', routeKind: 'host-task' as const, identifier: details.task.id, title: 'Greeting' };
    const result = await agent.start({ ...input, context, appTools: tools });
    expect(result.status).toBe('awaiting_confirmation');
    expect(result.mutated).toBe(true);
    expect(test).not.toHaveBeenCalled();
    expect(history.current().primaryScope).toMatchObject({ kind: 'host-task', id: details.task.id });
    expect(history.current().entityRefs).toContainEqual(expect.objectContaining({ kind: 'HostTask', id: details.task.id, relation: 'mutated' }));
    const reads = history.current().events.filter(event => event.type === 'tool_call' && event.toolName === 'desktop-host-task-read');
    expect(reads).toHaveLength(2);
    expect(reads[1]).not.toHaveProperty('dedupedOfCallId');
    expect(await agent.resolveConfirmation(result.pendingConfirmation!.id, true)).toMatchObject({ status: 'succeeded' });
    expect(test).toHaveBeenCalledOnce();
    expect(details.task.publishedVersion).toBe(1);
    const testCall = history.current().events.find(event => event.type === 'tool_call' && event.toolName === 'desktop-host-task-test-run');
    if (!testCall || testCall.type !== 'tool_call') throw new Error('The host test call was not journaled.');
    expect(history.current().events).toContainEqual(expect.objectContaining({ type: 'tool_result',
      callId: testCall.callId, result: expect.objectContaining({
        result: expect.objectContaining({ state: 'succeeded', result: { greeting: 'Hi Ada' } }),
      }) }));
    const current = history.current();
    expect(() => commandJournalSpec.parse({
      schemaVersion: current.schemaVersion, status: current.status, startedAt: current.startedAt,
      completedAt: current.completedAt, provider: current.provider, request: current.request,
      primaryScope: current.primaryScope, entityRefs: current.entityRefs, events: current.events, completion: current.completion,
    })).not.toThrow();
  });

  it('requires a separate approval for every test, even identical repeated tests', async () => {
    const { tools, details, test } = fixture();
    const args = { version: 1, definitionHash: details.task.definitionHash, parameters: { name: 'Ada' } };
    let id = 0;
    const agent = new DesktopChatAgent({ listTools: async () => [], callTool: vi.fn(), journal: journal(),
      callModel: vi.fn().mockResolvedValueOnce(turn(['desktop-host-task-test-run', args], ['desktop-host-task-test-run', args])).mockResolvedValueOnce(done),
      createId: () => `confirmation-${++id}` });
    const first = await agent.start({ ...input, appTools: tools });
    expect(first.pendingConfirmation?.batchCount).toBeUndefined();
    expect(test).not.toHaveBeenCalled();
    const second = await agent.resolveConfirmation(first.pendingConfirmation!.id, true);
    expect(second.status).toBe('awaiting_confirmation');
    expect(test).toHaveBeenCalledTimes(1);
    expect(second.pendingConfirmation!.id).not.toBe(first.pendingConfirmation!.id);
    await agent.resolveConfirmation(second.pendingConfirmation!.id, true);
    expect(test).toHaveBeenCalledTimes(2);
  });

  it('never executes a denied test and cancels a running host process on chat reset', async () => {
    const denied = fixture();
    const args = { version: 1, definitionHash: denied.details.task.definitionHash, parameters: { name: 'Ada' } };
    const agent = new DesktopChatAgent({ listTools: async () => [], callTool: vi.fn(), journal: journal(),
      callModel: vi.fn().mockResolvedValueOnce(turn(['desktop-host-task-test-run', args])).mockResolvedValueOnce(done) });
    const pending = await agent.start({ ...input, appTools: denied.tools });
    await agent.resolveConfirmation(pending.pendingConfirmation!.id, false);
    expect(denied.test).not.toHaveBeenCalled();

    const running = fixture();
    running.details.versions[0].definition.source = 'module.exports = () => { while (true) {} };';
    running.details.versions[0].definitionHash = scriptDefinitionHash(running.details.versions[0].definition);
    const second = new DesktopChatAgent({ listTools: async () => [], callTool: vi.fn(), journal: journal(),
      callModel: vi.fn().mockResolvedValueOnce(turn(['desktop-host-task-test-run', {
        ...args, definitionHash: running.details.versions[0].definitionHash,
      }])) });
    const approval = await second.start({ ...input, appTools: running.tools });
    const result = second.resolveConfirmation(approval.pendingConfirmation!.id, true);
    await vi.waitFor(() => expect(running.test).toHaveBeenCalledOnce());
    await second.reset();
    expect((await result).status).toBe('interrupted');
    expect(running.test.mock.calls[0][2]?.aborted).toBe(true);
  });
});
