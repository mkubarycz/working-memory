import { describe, expect, it, vi } from 'vitest';
import { DesktopChatAgent } from '../src/main/desktopChatAgent';
import type { CommandJournal, CommandJournalEntityRef } from '../../src/controlPlaneClient';
import { commandJournalSpec } from '../../control-plane/src/kinds/commandjournal';

const tools = [
  { name: 'ws-workstream-read', inputSchema: { type: 'object', properties: { slug: { type: 'string' } } } },
  { name: 'ws-topic-create', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'ws-topic-delete', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
];

function journalHarness() {
  let current: CommandJournal | undefined;
  const create = vi.fn(async (input): Promise<CommandJournal> => {
    current = {
      id: 'journal-1', resourceVersion: 1, createdAt: input.startedAt, updatedAt: input.startedAt,
      schemaVersion: 2, status: 'running', ...input, entityRefs: input.entityRefs ?? [], events: [],
    };
    return current;
  });
  const append = vi.fn(async (input): Promise<CommandJournal> => {
    if (!current || input.expectedResourceVersion !== current.resourceVersion) throw new Error('CAS mismatch');
    const refs = new Map(current.entityRefs.map((ref) => [`${ref.kind}:${ref.id}:${ref.relation}`, ref]));
    for (const ref of input.entityRefs ?? []) refs.set(`${ref.kind}:${ref.id}:${ref.relation}`, ref);
    const awaiting = input.events.some((event) => event.type === 'confirmation_requested')
      ? true
      : input.events.some((event) => event.type === 'confirmation_resolved')
        ? false
        : current.status === 'awaiting_confirmation';
    current = {
      ...current,
      resourceVersion: current.resourceVersion + 1,
      status: awaiting ? 'awaiting_confirmation' : 'running',
      events: [...current.events, ...input.events],
      entityRefs: [...refs.values()] as CommandJournalEntityRef[],
    };
    return current;
  });
  const finalize = vi.fn(async (input): Promise<CommandJournal> => {
    if (!current || input.expectedResourceVersion !== current.resourceVersion) throw new Error('CAS mismatch');
    current = { ...current, ...input, resourceVersion: current.resourceVersion + 1 };
    return current;
  });
  return { create, append, finalize, current: () => current };
}

function schemaValidatingJournalHarness() {
  const journal = journalHarness();
  const finalize = journal.finalize.getMockImplementation()!;
  journal.finalize.mockImplementation(async (input) => {
    const current = await finalize(input);
    commandJournalSpec.parse({
      schemaVersion: current.schemaVersion,
      status: current.status,
      startedAt: current.startedAt,
      completedAt: current.completedAt,
      provider: current.provider,
      request: current.request,
      primaryScope: current.primaryScope,
      entityRefs: current.entityRefs,
      events: current.events,
      completion: current.completion,
    });
    return current;
  });
  return journal;
}

function options(
  callModel: ReturnType<typeof vi.fn>,
  callTool = vi.fn(async () => ({ ok: true, result: {} })),
  journal = journalHarness(),
) {
  return { listTools: async () => tools, callTool, callModel, journal, createId: () => 'confirm-1' };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('DesktopChatAgent', () => {
  it('includes selected document identity and deictic-reference rules in model instructions', async () => {
    const callModel = vi.fn(async () => ({ id: 'resp_1', output_text: 'Found it.' }));
    const agent = new DesktopChatAgent(options(callModel));

    await agent.start({
      mode: 'responses',
      url: 'https://example.test',
      model: 'test',
      message: 'What is blocking this?',
      headers: {},
      context: { kind: 'topic', routeKind: 'topic', identifier: 'selected-topic', title: 'Selected topic' },
    });

    const instructions = callModel.mock.calls[0][0].body.instructions as string;
    expect(instructions).toContain('Selected document: kind="topic", identifier="selected-topic", title="Selected topic".');
    expect(instructions).toContain('"this", "it", and "current document"');
    expect(instructions).toContain('Use this exact kind and identifier in tool calls');
  });

  it('dispatches multiple read/create calls and continues to a final response', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ id: 'chatcmpl_1', usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [
        { id: 'a', function: { name: 'ws-workstream-read', arguments: '{"slug":"roadmap"}' } },
        { id: 'b', function: { name: 'ws-topic-create', arguments: '{"title":"Ship it"}' } },
      ] } }] })
      .mockResolvedValueOnce({ id: 'chatcmpl_2', usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 }, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done.' } }] });
    const callTool = vi.fn()
      .mockResolvedValueOnce({ ok: true, result: { slug: 'roadmap' } })
      .mockResolvedValueOnce({ ok: true, result: { slug: 'ship-it' } });
    const journal = journalHarness();
    const agent = new DesktopChatAgent(options(callModel, callTool, journal));
    const result = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'do it', headers: {} });
    expect(result).toMatchObject({ journalId: 'journal-1', message: 'Done.', mutated: true, navigation: { kind: 'topic', identifier: 'ship-it' } });
    expect(callTool).toHaveBeenCalledTimes(2);
    expect(journal.current()).toMatchObject({
      status: 'succeeded',
      completion: { mutated: true, usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 } },
    });
    expect(journal.current()?.events.map((event) => event.type)).toEqual([
      'model_turn', 'tool_call', 'tool_call', 'tool_result', 'tool_result', 'model_turn',
    ]);
    expect(journal.current()?.events[0]).toMatchObject({ providerResponseId: 'chatcmpl_1', finishReason: 'tool_calls' });
    expect(journal.current()?.events.at(-1)).toMatchObject({ providerResponseId: 'chatcmpl_2', finishReason: 'stop' });
    expect(journal.current()?.entityRefs).toContainEqual(expect.objectContaining({ kind: 'Workstream', id: 'roadmap', relation: 'referenced' }));
    expect(journal.current()?.entityRefs).toContainEqual(expect.objectContaining({ kind: 'Topic', id: 'ship-it', relation: 'mutated' }));
  });

  it('creates the durable journal before the first model request and strips endpoint secrets', async () => {
    const order: string[] = [];
    const journal = journalHarness();
    const createJournal = journal.create.getMockImplementation()!;
    journal.create.mockImplementationOnce(async (input) => {
      order.push('journal');
      expect(input.provider.endpoint).toBe('https://example.test/v1/responses');
      return createJournal(input);
    });
    const callModel = vi.fn(async () => { order.push('model'); return { id: 'resp_1', output_text: 'Done.' }; });
    await new DesktopChatAgent(options(callModel, undefined, journal)).start({
      mode: 'responses', url: 'https://user:pass@example.test/v1/responses?api_key=secret', model: 'test', message: 'read', headers: { authorization: 'secret' },
    });
    expect(order).toEqual(['journal', 'model']);
    expect(journal.create.mock.calls[0][0]).not.toHaveProperty('headers');
  });

  it('cannot execute a destructive call before explicit confirmation', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'a', function: { name: 'ws-topic-delete', arguments: '{"slug":"old"}' } },
      ] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'Deleted.' } }] });
    const callTool = vi.fn(async () => ({ ok: true, result: {} }));
    const journal = journalHarness();
    const agent = new DesktopChatAgent(options(callModel, callTool, journal));
    const pending = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'delete old', headers: {} });
    expect(pending.journalId).toBe('journal-1');
    expect(pending.pendingConfirmation).toEqual({ id: 'confirm-1', tool: 'ws-topic-delete', arguments: { slug: 'old' } });
    expect(callTool).not.toHaveBeenCalled();
    expect(journal.current()?.status).toBe('awaiting_confirmation');
    const result = await agent.resolveConfirmation('confirm-1', true);
    expect(result.journalId).toBe('journal-1');
    expect(callTool).toHaveBeenCalledWith('ws-topic-delete', { slug: 'old' });
    expect(result.message).toBe('Deleted.');
    expect(journal.current()?.events.map((event) => event.type)).toEqual([
      'model_turn', 'tool_call', 'confirmation_requested', 'confirmation_resolved', 'tool_result', 'model_turn',
    ]);
  });

  it('rejects and clears pending confirmations when the environment resets', async () => {
    const callModel = vi.fn().mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
      { id: 'a', function: { name: 'ws-topic-delete', arguments: '{"slug":"old"}' } },
    ] } }] });
    const journal = journalHarness();
    const agent = new DesktopChatAgent(options(callModel, undefined, journal));
    await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'delete old', headers: {} });

    await agent.reset();

    await expect(agent.resolveConfirmation('confirm-1', true)).rejects.toThrow('no longer exists');
    expect(journal.current()).toMatchObject({
      status: 'cancelled',
      completion: { stopReason: 'environment_changed', mutated: false },
    });
    expect(journal.current()?.events.at(-1)).toMatchObject({ type: 'confirmation_resolved', resolution: 'rejected' });
  });

  it('reset during callModel stops before tool execution and never reaches replacement persistence', async () => {
    const model = deferred<unknown>();
    const oldJournal = journalHarness();
    const replacementJournal = journalHarness();
    const oldCallTool = vi.fn(async () => ({ ok: true, result: {} }));
    const replacementCallTool = vi.fn(async () => ({ ok: true, result: {} }));
    let replacementSelected = false;
    const dependencies = () => replacementSelected
      ? { listTools: async () => tools, callTool: replacementCallTool, journal: replacementJournal }
      : { listTools: async () => tools, callTool: oldCallTool, journal: oldJournal };
    const agent = new DesktopChatAgent({
      ...options(vi.fn(() => model.promise), oldCallTool, oldJournal),
      resolveDependencies: dependencies,
    });
    const running = agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'read', headers: {} });
    await vi.waitFor(() => expect(oldJournal.create).toHaveBeenCalledOnce());
    const resetting = agent.reset();
    model.resolve({ choices: [{ message: { tool_calls: [
      { id: 'a', function: { name: 'ws-workstream-read', arguments: '{}' } },
    ] } }] });
    await resetting;
    replacementSelected = true;
    const result = await running;

    expect(result.message).toContain('environment changed');
    expect(oldCallTool).not.toHaveBeenCalled();
    expect(replacementCallTool).not.toHaveBeenCalled();
    expect(replacementJournal.append).not.toHaveBeenCalled();
    expect(replacementJournal.finalize).not.toHaveBeenCalled();
    expect(oldJournal.finalize).toHaveBeenCalledOnce();
    expect(oldJournal.current()).toMatchObject({
      status: 'interrupted', completion: { stopReason: 'environment_changed' },
    });
    expect(oldJournal.current()?.events.at(-1)).toMatchObject({ type: 'run_error', code: 'environment_changed' });
  });

  it('reset during callTool waits, persists only to the old journal, and finalizes once', async () => {
    const tool = deferred<{ ok: true; result: { slug: string } }>();
    const oldJournal = journalHarness();
    const replacementJournal = journalHarness();
    const oldCallTool = vi.fn(() => tool.promise);
    const replacementCallTool = vi.fn(async () => ({ ok: true, result: {} }));
    let replacementSelected = false;
    const agent = new DesktopChatAgent({
      ...options(vi.fn(async () => ({ choices: [{ message: { tool_calls: [
        { id: 'a', function: { name: 'ws-workstream-read', arguments: '{"slug":"roadmap"}' } },
      ] } }] })), oldCallTool, oldJournal),
      resolveDependencies: () => replacementSelected
        ? { listTools: async () => tools, callTool: replacementCallTool, journal: replacementJournal }
        : { listTools: async () => tools, callTool: oldCallTool, journal: oldJournal },
    });
    const running = agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'read', headers: {} });
    await vi.waitFor(() => expect(oldCallTool).toHaveBeenCalledOnce());
    const resetting = agent.reset();
    tool.resolve({ ok: true, result: { slug: 'roadmap' } });
    await resetting;
    replacementSelected = true;
    const result = await running;

    expect(result.message).toContain('environment changed');
    expect(replacementCallTool).not.toHaveBeenCalled();
    expect(replacementJournal.append).not.toHaveBeenCalled();
    expect(replacementJournal.finalize).not.toHaveBeenCalled();
    expect(oldJournal.finalize).toHaveBeenCalledOnce();
    expect(oldJournal.current()).toMatchObject({
      status: 'interrupted', completion: { stopReason: 'environment_changed' },
    });
    expect(oldJournal.current()?.events.filter((event) => event.type === 'tool_result')).toEqual([]);
  });

  it('cancellation is fed back without executing the destructive call', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ id: 'resp_1', output: [{ type: 'function_call', call_id: 'a', name: 'ws-topic-delete', arguments: '{"slug":"old"}' }] })
      .mockResolvedValueOnce({ id: 'resp_2', output_text: 'Cancelled.' });
    const callTool = vi.fn();
    const journal = journalHarness();
    const agent = new DesktopChatAgent(options(callModel, callTool, journal));
    await agent.start({ mode: 'responses', url: 'https://example.test', model: 'test', message: 'delete old', headers: {} });
    const result = await agent.resolveConfirmation('confirm-1', false);
    expect(callTool).not.toHaveBeenCalled();
    expect(result.progress.at(-1)?.status).toBe('cancelled');
    expect(callModel.mock.calls[1][0].body).toMatchObject({ previous_response_id: 'resp_1' });
    expect(journal.current()).toMatchObject({ status: 'cancelled', completion: { stopReason: 'user_rejected' } });
    expect(journal.current()?.events.map((event) => event.type)).toEqual([
      'model_turn', 'tool_call', 'confirmation_requested', 'confirmation_resolved', 'tool_result', 'model_turn',
    ]);
  });

  it('feeds failures and schema back so the model can retry', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'a', function: { name: 'ws-topic-create', arguments: '{}' } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'Fixed.' } }] });
    const callTool = vi.fn(async () => ({ ok: false, error: 'title is required' }));
    const agent = new DesktopChatAgent(options(callModel, callTool));
    const result = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'create', headers: {} });
    const continuation = callModel.mock.calls[1][0].body.messages.at(-1).content as string;
    expect(continuation).toContain('title is required');
    expect(continuation).toContain('"schema"');
    expect(result.message).toBe('Fixed.');
  });

  it('links a corrected call to the preceding failed call and executes it', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'failed', function: { name: 'ws-topic-create', arguments: '{}' } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'corrected', function: { name: 'ws-topic-create', arguments: '{"title":"Fixed"}' } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] });
    const callTool = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'title is required' })
      .mockResolvedValueOnce({ ok: true, result: { slug: 'fixed' } });
    const journal = journalHarness();
    await new DesktopChatAgent(options(callModel, callTool, journal)).start({
      mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'create', headers: {},
    });

    expect(callTool).toHaveBeenCalledTimes(2);
    const calls = journal.current()?.events.filter((event) => event.type === 'tool_call');
    expect(calls?.[1]).toMatchObject({ callId: 'corrected', retryOfCallId: 'failed' });
    expect(calls?.[1]).not.toHaveProperty('dedupedOfCallId');
  });

  it('chains repeated corrected failures to the immediately preceding failed call in Responses mode', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ id: 'resp_1', output: [{ type: 'function_call', call_id: 'failed', name: 'ws-topic-create', arguments: '{}' }] })
      .mockResolvedValueOnce({ id: 'resp_2', output: [{ type: 'function_call', call_id: 'correction-1', name: 'ws-topic-create', arguments: '{"title":"First"}' }] })
      .mockResolvedValueOnce({ id: 'resp_3', output: [{ type: 'function_call', call_id: 'correction-2', name: 'ws-topic-create', arguments: '{"title":"Second"}' }] })
      .mockResolvedValueOnce({ id: 'resp_4', output_text: 'Done.' });
    const callTool = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'title is required' })
      .mockResolvedValueOnce({ ok: false, error: 'title already exists' })
      .mockResolvedValueOnce({ ok: true, result: { slug: 'second' } });
    const journal = journalHarness();
    await new DesktopChatAgent(options(callModel, callTool, journal)).start({
      mode: 'responses', url: 'https://example.test', model: 'test', message: 'create', headers: {},
    });

    expect(callTool).toHaveBeenCalledTimes(3);
    const calls = journal.current()?.events.filter((event) => event.type === 'tool_call');
    expect(calls?.[1]).toMatchObject({ callId: 'correction-1', retryOfCallId: 'failed' });
    expect(calls?.[2]).toMatchObject({ callId: 'correction-2', retryOfCallId: 'correction-1' });
  });

  it('stops at the iteration cap', async () => {
    const callModel = vi.fn(async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [
      { id: crypto.randomUUID(), function: { name: 'ws-workstream-read', arguments: '{}' } },
    ] } }] }));
    const agent = new DesktopChatAgent({ ...options(callModel), maxIterations: 2 });
    const result = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'loop', headers: {} });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.message).toContain('Stopped after 2 model turns');
  });

  it('keeps an exact successful mutation repeat dedupe-only', async () => {
    const repeated = { id: 'a', function: { name: 'ws-topic-create', arguments: '{"title":"One"}' } };
    const callModel = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', tool_calls: [repeated] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', tool_calls: [{ ...repeated, id: 'b' }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] });
    const callTool = vi.fn(async () => ({ ok: true, result: { slug: 'one' } }));
    const journal = journalHarness();
    const agent = new DesktopChatAgent(options(callModel, callTool, journal));
    const result = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'create', headers: {} });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.progress.at(-1)?.summary).toBe('Skipped duplicate call');
    const calls = journal.current()?.events.filter((event) => event.type === 'tool_call');
    expect(calls?.[1]).toMatchObject({ dedupedOfCallId: 'a' });
    expect(calls?.[1]).not.toHaveProperty('retryOfCallId');
  });

  it('returns a bounded result when a model HTTP call fails', async () => {
    const journal = journalHarness();
    const agent = new DesktopChatAgent(options(vi.fn(async () => { throw new Error('network unavailable'); }), undefined, journal));
    const result = await agent.start({ mode: 'responses', url: 'https://example.test', model: 'test', message: 'read', headers: {} });
    expect(result.message).toBe('Model request failed: network unavailable');
    expect(journal.current()).toMatchObject({ status: 'failed', completion: { stopReason: 'model_error' } });
    expect(journal.current()?.events.at(-1)).toMatchObject({ type: 'run_error', stage: 'model_request' });
  });

  it('persists malformed arguments as a parse failure without calling the tool', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { tool_calls: [{ id: 'bad', function: { name: 'ws-topic-create', arguments: '{' } }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Could not create it.' } }] });
    const callTool = vi.fn();
    const journal = journalHarness();
    await new DesktopChatAgent(options(callModel, callTool, journal)).start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'create', headers: {} });
    expect(callTool).not.toHaveBeenCalled();
    expect(journal.current()?.events.find((event) => event.type === 'tool_call')).toMatchObject({ callId: 'bad', argumentParseError: expect.stringContaining('invalid JSON') });
    expect(journal.current()?.events.find((event) => event.type === 'tool_result')).toMatchObject({ callId: 'bad', status: 'failure' });
  });

  it('stops before the model when journal creation fails', async () => {
    const callModel = vi.fn();
    const journal = journalHarness();
    journal.create.mockRejectedValueOnce(new Error('control plane unavailable'));
    await expect(new DesktopChatAgent(options(callModel, undefined, journal)).start({
      mode: 'responses', url: 'https://example.test', model: 'test', message: 'read', headers: {},
    })).rejects.toThrow('Command journal create failed: control plane unavailable');
    expect(callModel).not.toHaveBeenCalled();
  });

  it('stops execution when an incremental append fails', async () => {
    const callModel = vi.fn(async () => ({ choices: [{ message: { tool_calls: [{ id: 'a', function: { name: 'ws-workstream-read', arguments: '{}' } }] } }] }));
    const callTool = vi.fn();
    const journal = journalHarness();
    journal.append.mockRejectedValueOnce(new Error('write failed'));
    await expect(new DesktopChatAgent(options(callModel, callTool, journal)).start({
      mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'read', headers: {},
    })).rejects.toThrow('Command journal append failed: write failed');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('redacts credential keys and embedded secret values from persisted text and payloads', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Using top-secret', tool_calls: [
        { id: 'a', function: { name: 'ws-workstream-read', arguments: '{"slug":"roadmap","authorization":"Bearer hidden-value"}' } },
      ] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: 'Done with top-secret' } }] });
    const callTool = vi.fn(async () => ({ ok: true, result: { slug: 'roadmap', note: 'token?api_key=hidden-value and top-secret' } }));
    const journal = journalHarness();
    await new DesktopChatAgent(options(callModel, callTool, journal)).start({
      mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'Use top-secret', headers: { authorization: 'top-secret' },
    });
    const persisted = JSON.stringify(journal.current());
    expect(persisted).not.toContain('top-secret');
    expect(persisted).not.toContain('hidden-value');
    expect(persisted).not.toContain('authorization');
    expect(persisted).toContain('[redacted]');
  });

  it('stops before another HTTP call once the total time cap is reached', async () => {
    const callModel = vi.fn();
    let time = 0;
    const agent = new DesktopChatAgent({
      ...options(callModel),
      totalTimeoutMs: 50,
      now: () => { time += 60; return time; },
    });
    const result = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'read', headers: {} });
    expect(callModel).not.toHaveBeenCalled();
    expect(result.message).toContain('total tool-run time limit');
  });

  it('navigates a specific read from the canonical collection envelope', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', tool_calls: [
        { id: 'a', function: { name: 'ws-workstream-read', arguments: '{"slug":"roadmap","authorization":"Bearer hidden-value"}' } },
      ] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'Opened.' } }] });
    const callTool = vi.fn(async () => ({ ok: true, result: { count: 1, workstreams: [{ slug: 'roadmap' }] } }));
    const journal = schemaValidatingJournalHarness();
    const agent = new DesktopChatAgent(options(callModel, callTool, journal));
    const result = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'open roadmap', headers: {} });
    expect(result.navigation).toEqual({ kind: 'workstream', identifier: 'roadmap' });
    expect(journal.current()?.completion?.navigationTarget).toEqual({ kind: 'Workstream', id: 'roadmap', slug: 'roadmap' });
    expect(journal.current()?.events.find((event) => event.type === 'tool_call')).toMatchObject({
      arguments: { slug: 'roadmap', sensitiveField1: '[redacted]' },
    });
  });
});