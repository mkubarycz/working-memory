import { test, expect } from 'vitest';
import {
  LlamaClient,
  parseChatResponse,
  type FetchLike,
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
