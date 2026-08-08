import { test, expect } from 'vitest';
import {
  runToolLoop,
  type ChatFn,
  type ToolExecutor,
  type ToolResult,
  type TraceEvent,
} from '../src/wmToolLoop';
import type { LlamaMessage } from '../src/llamaClient';

/** A `chat` seam that returns a scripted sequence of assistant turns. */
function scriptedChat(
  turns: LlamaMessage[],
  captured: { messages: LlamaMessage[][] },
): ChatFn {
  let i = 0;
  return async (messages) => {
    captured.messages.push(messages.map((m) => ({ ...m })));
    const message = turns[Math.min(i, turns.length - 1)];
    i += 1;
    return { message };
  };
}

/** A `chat` seam that always requests one more tool call (never stops). */
function neverStopsChat(): ChatFn {
  return async () => ({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'topic_read', arguments: {} } }],
    },
  });
}

/** An executor that records calls and returns canned results by tool name. */
function fakeExecutor(
  results: Record<string, ToolResult> = {},
): ToolExecutor & { calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    async execute(name, args) {
      calls.push({ name, args });
      return results[name] ?? { ok: true, result: { slug: 'from-tool' } };
    },
  };
}

test('(a) one tool call then a final answer → stopReason final, trail recorded, context threaded', async () => {
  const captured = { messages: [] as LlamaMessage[][] };
  const chat = scriptedChat(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'topic_read', arguments: { slug: 'my-topic' } } },
        ],
      },
      { role: 'assistant', content: 'Read the topic and updated it.' },
    ],
    captured,
  );
  const executor = fakeExecutor();

  const result = await runToolLoop({
    chat,
    executor,
    command: 'update the topic',
    contextSlug: 'my-topic',
    contextKind: 'topic',
  });

  expect(result.stopReason).toBe('final');
  expect(result.finalText).toBe('Read the topic and updated it.');
  expect(result.iterations).toBe(2);
  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls[0]).toMatchObject({
    name: 'topic_read',
    args: { slug: 'my-topic' },
    ok: true,
    destructive: false,
  });
  expect(executor.calls).toHaveLength(1);

  // The context slug must be threaded into both the system prompt and the
  // user turn of the FIRST model call.
  const first = captured.messages[0];
  const system = first.find((m) => m.role === 'system');
  const user = first.find((m) => m.role === 'user');
  expect(system?.content).toContain('my-topic');
  expect(user?.content).toContain('my-topic');
});

test('(b) a model that never stops → stopReason max-iterations', async () => {
  const executor = fakeExecutor();
  const result = await runToolLoop({
    chat: neverStopsChat(),
    executor,
    command: 'loop forever',
    contextSlug: null,
    maxIterations: 3,
  });

  expect(result.stopReason).toBe('max-iterations');
  expect(result.iterations).toBe(3);
  expect(result.finalText).toBe('');
  expect(result.toolCalls).toHaveLength(3);
});

test('(c) a chat that throws → stopReason error', async () => {
  const chat: ChatFn = async () => {
    throw new Error('local model unreachable');
  };
  const result = await runToolLoop({
    chat,
    executor: fakeExecutor(),
    command: 'anything',
    contextSlug: null,
  });

  expect(result.stopReason).toBe('error');
  expect(result.error).toContain('local model unreachable');
  expect(result.toolCalls).toHaveLength(0);
});

test('(d) a destructive delete tool is recorded with destructive: true', async () => {
  const captured = { messages: [] as LlamaMessage[][] };
  const chat = scriptedChat(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'topic_delete', arguments: { slug: 'doomed' } } },
        ],
      },
      { role: 'assistant', content: 'Deleted it.' },
    ],
    captured,
  );
  const executor = fakeExecutor({
    topic_delete: { ok: true, result: { ok: true, slug: 'doomed' }, destructive: true },
  });

  const result = await runToolLoop({
    chat,
    executor,
    command: 'delete the doomed topic',
    contextSlug: null,
  });

  expect(result.stopReason).toBe('final');
  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls[0]).toMatchObject({
    name: 'topic_delete',
    destructive: true,
    ok: true,
  });
});

test('(e) same create emitted TWICE in one turn → executed once, second deduped, prior result fed back', async () => {
  const captured = { messages: [] as LlamaMessage[][] };
  const dupCall = {
    function: { name: 'workstream_create', arguments: { title: 'My Stream' } },
  };
  const chat = scriptedChat(
    [
      {
        role: 'assistant',
        content: '',
        // The model emits the SAME workstream_create twice in a single turn.
        tool_calls: [dupCall, { ...dupCall }],
      },
      { role: 'assistant', content: 'Created the workstream.' },
    ],
    captured,
  );
  const executor = fakeExecutor({
    workstream_create: { ok: true, result: { slug: 'my-stream', title: 'My Stream' } },
  });

  const result = await runToolLoop({
    chat,
    executor,
    command: 'make a workstream called My Stream',
    contextSlug: null,
  });

  expect(result.stopReason).toBe('final');
  // Executor ran ONCE even though the model asked twice.
  expect(executor.calls).toHaveLength(1);
  // Both calls are in the trail; the second is flagged deduped.
  expect(result.toolCalls).toHaveLength(2);
  expect(result.toolCalls[0]).toMatchObject({ name: 'workstream_create' });
  expect(result.toolCalls[0].deduped).toBeFalsy();
  expect(result.toolCalls[1]).toMatchObject({ name: 'workstream_create', deduped: true });

  // The SECOND turn the model saw must contain a tool message referencing the
  // prior result (deduped) so it stops repeating the create.
  const secondTurn = captured.messages[1];
  const toolMsgs = secondTurn.filter((m) => m.role === 'tool');
  expect(toolMsgs).toHaveLength(2);
  const deduped = JSON.parse(toolMsgs[1].content) as { deduped?: boolean; result?: unknown };
  expect(deduped.deduped).toBe(true);
  expect(deduped.result).toMatchObject({ slug: 'my-stream' });
});

test('(f) same create repeated across TWO turns → still executed only once', async () => {
  const captured = { messages: [] as LlamaMessage[][] };
  const call = {
    role: 'assistant' as const,
    content: '',
    tool_calls: [{ function: { name: 'workstream_create', arguments: { title: 'Repeat' } } }],
  };
  const chat = scriptedChat(
    [call, call, { role: 'assistant', content: 'Done.' }],
    captured,
  );
  const executor = fakeExecutor({
    workstream_create: { ok: true, result: { slug: 'repeat' } },
  });

  const result = await runToolLoop({
    chat,
    executor,
    command: 'create Repeat',
    contextSlug: null,
  });

  expect(result.stopReason).toBe('final');
  expect(executor.calls).toHaveLength(1);
  expect(result.toolCalls).toHaveLength(2);
  expect(result.toolCalls[1].deduped).toBe(true);
});

test('(g) trace fires a turn event with the raw calls and an exec event per call', async () => {
  const captured = { messages: [] as LlamaMessage[][] };
  const chat = scriptedChat(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'workstream_create', arguments: { title: 'T' } } },
          { function: { name: 'workstream_create', arguments: { title: 'T' } } },
        ],
      },
      { role: 'assistant', content: 'ok' },
    ],
    captured,
  );
  const events: TraceEvent[] = [];

  await runToolLoop({
    chat,
    executor: fakeExecutor(),
    command: 'trace me',
    contextSlug: null,
    trace: (e) => events.push(e),
  });

  const turn = events.find((e) => e.type === 'turn');
  expect(turn).toMatchObject({ type: 'turn', iteration: 1, toolCallCount: 2 });
  const execs = events.filter((e) => e.type === 'exec');
  expect(execs.map((e) => (e.type === 'exec' ? e.outcome : ''))).toEqual(['ok', 'deduped']);
});
