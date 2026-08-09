import { test, expect } from 'vitest';
import {
  runToolLoop,
  buildSystemPrompt,
  type ChatFn,
  type ToolExecutor,
  type ToolResult,
  type TraceEvent,
} from '../src/wmToolLoop';
import type { LlamaMessage, LlamaToolDef } from '../src/llamaClient';

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

test('(h) prior turns are prepended as user/assistant messages before the new user turn', async () => {
  const captured = { messages: [] as LlamaMessage[][] };
  const chat = scriptedChat([{ role: 'assistant', content: 'ack' }], captured);

  await runToolLoop({
    chat,
    executor: fakeExecutor(),
    command: 'the new command',
    contextSlug: null,
    history: [
      { command: 'first command', brief: 'first brief' },
      { command: 'second command', brief: 'second brief' },
    ],
  });

  const first = captured.messages[0];
  // system, then the two prior turns (user/assistant each), then the new user.
  const roles = first.map((m) => m.role);
  expect(roles).toEqual(['system', 'user', 'assistant', 'user', 'assistant', 'user']);
  expect(first[1].content).toBe('first command');
  expect(first[2].content).toBe('first brief');
  expect(first[3].content).toBe('second command');
  expect(first[4].content).toBe('second brief');
  // The live user turn comes AFTER the replayed history and carries the command.
  expect(first[5].content).toContain('the new command');
});

test('(i) token counts accumulate across turns into result.tokens', async () => {
  let call = 0;
  const chat: ChatFn = async () => {
    call += 1;
    if (call === 1) {
      return {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'topic_read', arguments: {} } }],
        },
        promptEvalCount: 100,
        evalCount: 20,
      };
    }
    return {
      message: { role: 'assistant', content: 'done' },
      promptEvalCount: 150,
      evalCount: 5,
    };
  };

  const result = await runToolLoop({
    chat,
    executor: fakeExecutor(),
    command: 'count tokens',
    contextSlug: null,
  });

  expect(result.tokens).toEqual({ promptTokens: 250, evalTokens: 25, calls: 2 });
});

test('(k) per-call model timings accumulate across turns with an injected fake clock', async () => {
  // The loop reads `now()` exactly twice per model turn (start, end). Feed a
  // scripted sequence so each turn's duration is deterministic: turn 1 = 10ms,
  // turn 2 = 25ms → modelMs 35, perCallMs [10, 25], modelCalls 2.
  const ticks = [0, 10, 10, 35];
  let i = 0;
  const now = () => ticks[Math.min(i++, ticks.length - 1)];

  const captured = { messages: [] as LlamaMessage[][] };
  const chat = scriptedChat(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'topic_read', arguments: {} } }],
      },
      { role: 'assistant', content: 'done' },
    ],
    captured,
  );

  const result = await runToolLoop({
    chat,
    executor: fakeExecutor(),
    command: 'time me',
    contextSlug: null,
    now,
  });

  expect(result.timings.modelCalls).toBe(2);
  expect(result.timings.perCallMs).toEqual([10, 25]);
  expect(result.timings.modelMs).toBe(35);
});

test('(l) turn trace event carries the per-call model duration (ms)', async () => {
  const ticks = [0, 42, 42, 42];
  let i = 0;
  const now = () => ticks[Math.min(i++, ticks.length - 1)];

  const captured = { messages: [] as LlamaMessage[][] };
  const chat = scriptedChat(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'topic_read', arguments: {} } }],
      },
      { role: 'assistant', content: 'done' },
    ],
    captured,
  );
  const events: TraceEvent[] = [];

  await runToolLoop({
    chat,
    executor: fakeExecutor(),
    command: 'trace timing',
    contextSlug: null,
    now,
    trace: (e) => events.push(e),
  });

  const firstTurn = events.find((e) => e.type === 'turn');
  expect(firstTurn && firstTurn.type === 'turn' && firstTurn.perCallMs).toBe(42);
});

test('(j) a tool that fails then succeeds records a recovered Correction and feeds back the hint + schema', async () => {
  const captured = { messages: [] as LlamaMessage[][] };
  const chat = scriptedChat(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'topic_create', arguments: { title: '' } } }],
      },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'topic_create', arguments: { title: 'Fixed', slug: 'fixed' } } },
        ],
      },
      { role: 'assistant', content: 'Created it after fixing the args.' },
    ],
    captured,
  );

  // topic_create fails the first time, succeeds the second.
  let creates = 0;
  const executor: ToolExecutor & { calls: { name: string; args: Record<string, unknown> }[] } = {
    calls: [],
    async execute(name, args) {
      this.calls.push({ name, args });
      if (name === 'topic_create') {
        creates += 1;
        if (creates === 1) {
          return { ok: false, error: 'title is required' };
        }
        return { ok: true, result: { slug: 'fixed', title: 'Fixed' } };
      }
      return { ok: true, result: {} };
    },
  };

  const result = await runToolLoop({
    chat,
    executor,
    command: 'create a topic',
    contextSlug: null,
    tools: [
      {
        type: 'function',
        function: {
          name: 'topic_create',
          description: 'Create a topic.',
          parameters: {
            type: 'object',
            properties: { title: { type: 'string' }, slug: { type: 'string' } },
            required: ['title'],
          },
        },
      },
    ],
  });

  expect(result.stopReason).toBe('final');
  expect(result.corrections).toHaveLength(1);
  expect(result.corrections[0]).toMatchObject({
    tool: 'topic_create',
    error: 'title is required',
    recovered: true,
    retriedArgs: { title: 'Fixed', slug: 'fixed' },
  });

  // The failed-call tool message fed back to the model (visible on the SECOND
  // model turn) carries the corrective hint AND the tool's parameter schema.
  const secondTurn = captured.messages[1];
  const toolMsg = secondTurn.find((m) => m.role === 'tool');
  expect(toolMsg).toBeDefined();
  const fed = JSON.parse(toolMsg!.content) as {
    ok: boolean;
    error: string;
    hint?: string;
    schema?: { properties?: Record<string, unknown>; required?: string[] };
  };
  expect(fed.ok).toBe(false);
  expect(fed.error).toBe('title is required');
  expect(fed.hint).toContain('topic_create');
  expect(fed.hint?.toLowerCase()).toContain('schema');
  expect(fed.schema?.properties).toBeDefined();
  expect(fed.schema?.required).toContain('title');
});

test('(m) a BATCH of distinct tool calls in one turn all execute; all results fed back before the next turn', async () => {
  const captured = { messages: [] as LlamaMessage[][] };
  const chat = scriptedChat(
    [
      {
        role: 'assistant',
        content: '',
        // Three INDEPENDENT creates batched into a single turn.
        tool_calls: [
          { function: { name: 'topic_create', arguments: { title: 'One', slug: 'one' } } },
          { function: { name: 'topic_create', arguments: { title: 'Two', slug: 'two' } } },
          { function: { name: 'topic_create', arguments: { title: 'Three', slug: 'three' } } },
        ],
      },
      { role: 'assistant', content: 'Created all three topics.' },
    ],
    captured,
  );
  const executor = fakeExecutor();

  const result = await runToolLoop({
    chat,
    executor,
    command: 'create One, Two and Three',
    contextSlug: null,
  });

  expect(result.stopReason).toBe('final');
  // All three ran in a SINGLE turn; the whole run took only two model calls.
  expect(executor.calls).toHaveLength(3);
  expect(result.toolCalls).toHaveLength(3);
  expect(result.toolCalls.every((c) => c.ok && !c.deduped)).toBe(true);
  expect(result.iterations).toBe(2);
  expect(result.tokens.calls).toBe(2);
  expect(result.timings.modelCalls).toBe(2);

  // The SECOND model turn must carry a tool result message for EACH batched
  // call, fed back together before the model responded.
  const secondTurn = captured.messages[1];
  const toolMsgs = secondTurn.filter((m) => m.role === 'tool');
  expect(toolMsgs).toHaveLength(3);
  expect(toolMsgs.every((m) => m.tool_name === 'topic_create')).toBe(true);
});

test('(n) dedup still applies WITHIN a single batch (distinct + duplicate mixed)', async () => {
  const captured = { messages: [] as LlamaMessage[][] };
  const chat = scriptedChat(
    [
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'workstream_create', arguments: { title: 'Alpha' } } },
          { function: { name: 'workstream_create', arguments: { title: 'Beta' } } },
          // Duplicate of the first call in the SAME batch.
          { function: { name: 'workstream_create', arguments: { title: 'Alpha' } } },
        ],
      },
      { role: 'assistant', content: 'Created Alpha and Beta.' },
    ],
    captured,
  );
  let n = 0;
  const executor: ToolExecutor & { calls: { name: string; args: Record<string, unknown> }[] } = {
    calls: [],
    async execute(name, args) {
      this.calls.push({ name, args });
      n += 1;
      return { ok: true, result: { slug: `ws-${n}`, title: args.title } };
    },
  };

  const result = await runToolLoop({
    chat,
    executor,
    command: 'create Alpha and Beta',
    contextSlug: null,
  });

  expect(result.stopReason).toBe('final');
  // Only the two DISTINCT creates executed; the duplicate was skipped.
  expect(executor.calls).toHaveLength(2);
  expect(result.toolCalls).toHaveLength(3);
  expect(result.toolCalls[2].deduped).toBe(true);
});

test('(n) the system prompt grants permission to answer meta-questions about its own tools from the catalog', () => {
  const tools: LlamaToolDef[] = [
    {
      type: 'function',
      function: {
        name: 'topic_read',
        description: 'Read a topic by slug.',
        parameters: {
          type: 'object',
          properties: { slug: { type: 'string' } },
          required: ['slug'],
        },
      },
    },
  ];

  const prompt = buildSystemPrompt('my-topic', 'topic', tools);

  // The framing permits answering questions about its own tools directly...
  expect(prompt).toContain('answer the user\'s questions about yourself');
  // ...the catalog is framed as the authoritative, complete list...
  expect(prompt).toContain('COMPLETE, authoritative list');
  // ...and there is an explicit rule to respond (not refuse, not look it up).
  expect(prompt).toContain('what tools you have');
  expect(prompt).toContain('Do NOT refuse');
  // The projected tool still appears in the catalog it can enumerate from.
  expect(prompt).toContain('topic_read(slug*)');
});


