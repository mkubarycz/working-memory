import { describe, expect, it, vi } from 'vitest';
import { DesktopChatAgent } from '../src/main/desktopChatAgent';

const tools = [
  { name: 'ws-workstream-read', inputSchema: { type: 'object', properties: { slug: { type: 'string' } } } },
  { name: 'ws-topic-create', inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'ws-topic-delete', inputSchema: { type: 'object', properties: { slug: { type: 'string' } }, required: ['slug'] } },
];

function options(callModel: ReturnType<typeof vi.fn>, callTool = vi.fn(async () => ({ ok: true, result: {} }))) {
  return { listTools: async () => tools, callTool, callModel, createId: () => 'confirm-1' };
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
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'a', function: { name: 'ws-workstream-read', arguments: '{"slug":"roadmap"}' } },
        { id: 'b', function: { name: 'ws-topic-create', arguments: '{"title":"Ship it"}' } },
      ] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] });
    const callTool = vi.fn()
      .mockResolvedValueOnce({ ok: true, result: { slug: 'roadmap' } })
      .mockResolvedValueOnce({ ok: true, result: { slug: 'ship-it' } });
    const agent = new DesktopChatAgent(options(callModel, callTool));
    const result = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'do it', headers: {} });
    expect(result).toMatchObject({ message: 'Done.', mutated: true, navigation: { kind: 'topic', identifier: 'ship-it' } });
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('cannot execute a destructive call before explicit confirmation', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
        { id: 'a', function: { name: 'ws-topic-delete', arguments: '{"slug":"old"}' } },
      ] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'Deleted.' } }] });
    const callTool = vi.fn(async () => ({ ok: true, result: {} }));
    const agent = new DesktopChatAgent(options(callModel, callTool));
    const pending = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'delete old', headers: {} });
    expect(pending.pendingConfirmation).toEqual({ id: 'confirm-1', tool: 'ws-topic-delete', arguments: { slug: 'old' } });
    expect(callTool).not.toHaveBeenCalled();
    const result = await agent.resolveConfirmation('confirm-1', true);
    expect(callTool).toHaveBeenCalledWith('ws-topic-delete', { slug: 'old' });
    expect(result.message).toBe('Deleted.');
  });

  it('cancellation is fed back without executing the destructive call', async () => {
    const callModel = vi.fn()
      .mockResolvedValueOnce({ id: 'resp_1', output: [{ type: 'function_call', call_id: 'a', name: 'ws-topic-delete', arguments: '{"slug":"old"}' }] })
      .mockResolvedValueOnce({ id: 'resp_2', output_text: 'Cancelled.' });
    const callTool = vi.fn();
    const agent = new DesktopChatAgent(options(callModel, callTool));
    await agent.start({ mode: 'responses', url: 'https://example.test', model: 'test', message: 'delete old', headers: {} });
    const result = await agent.resolveConfirmation('confirm-1', false);
    expect(callTool).not.toHaveBeenCalled();
    expect(result.progress.at(-1)?.status).toBe('cancelled');
    expect(callModel.mock.calls[1][0].body).toMatchObject({ previous_response_id: 'resp_1' });
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

  it('stops at the iteration cap', async () => {
    const callModel = vi.fn(async () => ({ choices: [{ message: { role: 'assistant', tool_calls: [
      { id: crypto.randomUUID(), function: { name: 'ws-workstream-read', arguments: '{}' } },
    ] } }] }));
    const agent = new DesktopChatAgent({ ...options(callModel), maxIterations: 2 });
    const result = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'loop', headers: {} });
    expect(callModel).toHaveBeenCalledTimes(2);
    expect(result.message).toContain('Stopped after 2 model turns');
  });

  it('does not re-execute an identical create call', async () => {
    const repeated = { id: 'a', function: { name: 'ws-topic-create', arguments: '{"title":"One"}' } };
    const callModel = vi.fn()
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', tool_calls: [repeated] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', tool_calls: [{ ...repeated, id: 'b' }] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] });
    const callTool = vi.fn(async () => ({ ok: true, result: { slug: 'one' } }));
    const agent = new DesktopChatAgent(options(callModel, callTool));
    const result = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'create', headers: {} });
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(result.progress.at(-1)?.summary).toBe('Skipped duplicate call');
  });

  it('returns a bounded result when a model HTTP call fails', async () => {
    const agent = new DesktopChatAgent(options(vi.fn(async () => { throw new Error('network unavailable'); })));
    const result = await agent.start({ mode: 'responses', url: 'https://example.test', model: 'test', message: 'read', headers: {} });
    expect(result.message).toBe('Model request failed: network unavailable');
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
        { id: 'a', function: { name: 'ws-workstream-read', arguments: '{"slug":"roadmap"}' } },
      ] } }] })
      .mockResolvedValueOnce({ choices: [{ message: { role: 'assistant', content: 'Opened.' } }] });
    const callTool = vi.fn(async () => ({ ok: true, result: { count: 1, workstreams: [{ slug: 'roadmap' }] } }));
    const agent = new DesktopChatAgent(options(callModel, callTool));
    const result = await agent.start({ mode: 'chat-completions', url: 'https://example.test', model: 'test', message: 'open roadmap', headers: {} });
    expect(result.navigation).toEqual({ kind: 'workstream', identifier: 'roadmap' });
  });
});