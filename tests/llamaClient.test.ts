import { test, expect } from 'vitest';
import {
  LlamaClient,
  parseChatResponse,
  parseEnvelopeResponse,
  buildToolEnvelopeSchema,
  type FetchLike,
  type LlamaToolDef,
} from '../src/llamaClient';

// --- parseChatResponse -----------------------------------------------------

test('parses a plain content response', () => {
  const raw = JSON.stringify({
    message: { role: 'assistant', content: 'hello there' },
    done_reason: 'stop',
    prompt_eval_count: 10,
    eval_count: 4,
  });
  const res = parseChatResponse(raw);
  expect(res.message.content).toBe('hello there');
  expect(res.message.tool_calls).toBeUndefined();
  expect(res.doneReason).toBe('stop');
  expect(res.promptEvalCount).toBe(10);
  expect(res.evalCount).toBe(4);
});

test('normalizes tool_calls with object args', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'topic_read', arguments: { slug: 'foo' } } },
      ],
    },
  });
  const res = parseChatResponse(raw);
  expect(res.message.tool_calls).toHaveLength(1);
  expect(res.message.tool_calls?.[0].function).toEqual({
    name: 'topic_read',
    arguments: { slug: 'foo' },
  });
});

test('normalizes tool_calls with JSON-string args', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [
        { function: { name: 'topic_update', arguments: '{"slug":"bar","status":"closed"}' } },
      ],
    },
  });
  const res = parseChatResponse(raw);
  expect(res.message.tool_calls?.[0].function.arguments).toEqual({
    slug: 'bar',
    status: 'closed',
  });
});

test('throws on an {error} body', () => {
  const raw = JSON.stringify({ error: 'model not found' });
  expect(() => parseChatResponse(raw)).toThrow(/model not found/);
});

test('throws on non-JSON', () => {
  expect(() => parseChatResponse('<html>nope</html>')).toThrow(/non-JSON/);
});

// --- LlamaClient.chat ------------------------------------------------------

test('chat posts to /api/chat with the expected method and body shape', async () => {
  const seen: { url?: string; init?: Parameters<FetchLike>[1] } = {};
  const fetchImpl: FetchLike = async (url, init) => {
    seen.url = url;
    seen.init = init;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return JSON.stringify({ message: { role: 'assistant', content: 'ok' } });
      },
    };
  };
  const client = new LlamaClient({
    baseUrl: 'http://localhost:11434/',
    model: 'qwen2.5:14b',
    fetchImpl,
  });

  const res = await client.chat([{ role: 'user', content: 'hi' }], []);
  expect(res.message.content).toBe('ok');

  // Trailing slash on baseUrl must not double up.
  expect(seen.url).toBe('http://localhost:11434/api/chat');
  expect(seen.init?.method).toBe('POST');
  const body = JSON.parse(seen.init?.body ?? '{}');
  expect(body.model).toBe('qwen2.5:14b');
  expect(body.stream).toBe(false);
  expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  expect(Array.isArray(body.tools)).toBe(true);
});

test('chat throws on a non-2xx response', async () => {
  const fetchImpl: FetchLike = async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    async text() {
      return 'boom';
    },
  });
  const client = new LlamaClient({
    baseUrl: 'http://localhost:11434',
    model: 'qwen2.5:14b',
    fetchImpl,
  });

  await expect(client.chat([{ role: 'user', content: 'hi' }], [])).rejects.toThrow(
    /HTTP 500/,
  );
});

// --- constrained decoding: envelope schema + parsing -----------------------

const CREATE_TOOLS: LlamaToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'topic_create',
      description: 'Create a topic.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          slug: { type: 'string' },
        },
        required: ['title', 'slug'],
        additionalProperties: false,
      },
    },
  },
];

test('buildToolEnvelopeSchema wraps each tool + a respond branch under actions.items.anyOf', () => {
  const schema = buildToolEnvelopeSchema(CREATE_TOOLS) as {
    properties: { actions: { type: string; minItems: number; items: { anyOf: Array<Record<string, unknown>> } } };
    required: string[];
  };
  expect(schema.required).toEqual(['actions']);
  const actions = schema.properties.actions;
  // The top-level `actions` is a bounded array so the model can batch calls.
  expect(actions.type).toBe('array');
  expect(actions.minItems).toBe(1);
  const branches = actions.items.anyOf;
  // One branch per tool + the respond branch.
  expect(branches).toHaveLength(2);
  const toolBranch = branches[0] as {
    properties: { tool: { const: string }; args: unknown };
    required: string[];
  };
  expect(toolBranch.properties.tool.const).toBe('topic_create');
  // The tool's own parameters schema (with required slug) is carried as `args`.
  expect(toolBranch.properties.args).toEqual(CREATE_TOOLS[0].function.parameters);
  const respondBranch = branches[1] as { properties: { tool: { const: string } } };
  expect(respondBranch.properties.tool.const).toBe('respond');
});

test('parseEnvelopeResponse maps a tool branch to a synthesized tool_call', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: JSON.stringify({
        action: {
          tool: 'topic_create',
          args: { title: 'Product Roadmap', slug: 'product-roadmap' },
        },
      }),
    },
    done_reason: 'stop',
  });
  const res = parseEnvelopeResponse(raw);
  expect(res.message.tool_calls).toHaveLength(1);
  expect(res.message.tool_calls?.[0].function).toEqual({
    name: 'topic_create',
    arguments: { title: 'Product Roadmap', slug: 'product-roadmap' },
  });
  expect(res.message.content).toBe('');
  expect(res.doneReason).toBe('stop');
});

test('parseEnvelopeResponse maps a respond branch to final content (no tool_calls)', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: JSON.stringify({ action: { tool: 'respond', message: 'All done.' } }),
    },
  });
  const res = parseEnvelopeResponse(raw);
  expect(res.message.tool_calls).toBeUndefined();
  expect(res.message.content).toBe('All done.');
});

test('parseEnvelopeResponse tolerates a top-level action (no wrapper)', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: JSON.stringify({ tool: 'topic_read', args: { slug: 'foo' } }),
    },
  });
  const res = parseEnvelopeResponse(raw);
  expect(res.message.tool_calls?.[0].function).toEqual({
    name: 'topic_read',
    arguments: { slug: 'foo' },
  });
});

test('parseEnvelopeResponse falls back to raw content when it is not an envelope', () => {
  const raw = JSON.stringify({
    message: { role: 'assistant', content: 'just some plain text' },
  });
  const res = parseEnvelopeResponse(raw);
  expect(res.message.tool_calls).toBeUndefined();
  expect(res.message.content).toBe('just some plain text');
});

test('chatConstrained posts `format` (not `tools`) and parses the envelope', async () => {
  const seen: { init?: Parameters<FetchLike>[1] } = {};
  const fetchImpl: FetchLike = async (_url, init) => {
    seen.init = init;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      async text() {
        return JSON.stringify({
          message: {
            role: 'assistant',
            content: JSON.stringify({
              action: { tool: 'topic_create', args: { title: 'X', slug: 'x-topic' } },
            }),
          },
        });
      },
    };
  };
  const client = new LlamaClient({ baseUrl: 'http://localhost:11434', model: 'qwen3:14b', fetchImpl });
  const res = await client.chatConstrained([{ role: 'user', content: 'make x' }], CREATE_TOOLS);

  const body = JSON.parse(seen.init?.body ?? '{}');
  expect(body.format).toBeDefined();
  expect(body.tools).toBeUndefined();
  expect(body.format.properties.actions.items.anyOf).toHaveLength(2);
  expect(res.message.tool_calls?.[0].function.name).toBe('topic_create');
});

// --- multi-action envelope (WM 14.2.1 multiple-tool-calls-per-turn) ---------

test('parseEnvelopeResponse maps a multi-action envelope to one tool_call per action', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: JSON.stringify({
        actions: [
          { tool: 'topic_create', args: { title: 'A', slug: 'a-topic' } },
          { tool: 'topic_create', args: { title: 'B', slug: 'b-topic' } },
          { tool: 'topic_read', args: { slug: 'c-topic' } },
        ],
      }),
    },
  });
  const res = parseEnvelopeResponse(raw);
  expect(res.message.tool_calls).toHaveLength(3);
  expect(res.message.tool_calls?.map((c) => c.function.name)).toEqual([
    'topic_create',
    'topic_create',
    'topic_read',
  ]);
  expect(res.message.tool_calls?.[1].function.arguments).toEqual({ title: 'B', slug: 'b-topic' });
  expect(res.message.content).toBe('');
});

test('parseEnvelopeResponse maps an actions array with only respond to final text', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: JSON.stringify({ actions: [{ tool: 'respond', message: 'All set.' }] }),
    },
  });
  const res = parseEnvelopeResponse(raw);
  expect(res.message.tool_calls).toBeUndefined();
  expect(res.message.content).toBe('All set.');
});

test('parseEnvelopeResponse drops a trailing respond when tool calls are present', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: JSON.stringify({
        actions: [
          { tool: 'topic_read', args: { slug: 'foo' } },
          { tool: 'respond', message: 'done' },
        ],
      }),
    },
  });
  const res = parseEnvelopeResponse(raw);
  // Tool calls win this turn; the respond is deferred to a later turn.
  expect(res.message.tool_calls).toHaveLength(1);
  expect(res.message.tool_calls?.[0].function.name).toBe('topic_read');
  expect(res.message.content).toBe('');
});

test('parseEnvelopeResponse still handles the legacy single-action envelope', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: JSON.stringify({
        action: { tool: 'topic_create', args: { title: 'X', slug: 'x-topic' } },
      }),
    },
  });
  const res = parseEnvelopeResponse(raw);
  expect(res.message.tool_calls).toHaveLength(1);
  expect(res.message.tool_calls?.[0].function).toEqual({
    name: 'topic_create',
    arguments: { title: 'X', slug: 'x-topic' },
  });
});

test('parseEnvelopeResponse tolerates a bare top-level array of actions', () => {
  const raw = JSON.stringify({
    message: {
      role: 'assistant',
      content: JSON.stringify([
        { tool: 'topic_read', args: { slug: 'a' } },
        { tool: 'workstream_read', args: {} },
      ]),
    },
  });
  const res = parseEnvelopeResponse(raw);
  expect(res.message.tool_calls?.map((c) => c.function.name)).toEqual([
    'topic_read',
    'workstream_read',
  ]);
});
