import { test, expect } from 'vitest';
import {
  buildBrief,
  createControlPlaneToolExecutor,
  stripToolScaffolding,
} from '../src/wmToolExecutor';
import type { ControlPlaneClient } from '../src/controlPlaneClient';
import type { ToolCallRecord } from '../src/wmToolLoop';

test('buildBrief flags destructive deletes and lists the tool-call trail', () => {
  const toolCalls: ToolCallRecord[] = [
    { name: 'topic_read', args: { slug: 'foo' }, ok: true, destructive: false },
    { name: 'topic_delete', args: { slug: 'foo' }, ok: true, destructive: true },
  ];
  const brief = buildBrief({
    finalText: 'Removed the topic.',
    toolCalls,
    stopReason: 'final',
  });

  expect(brief).toContain('Removed the topic.');
  // Destructive callout section + the trail both present.
  expect(brief).toContain('Destructive actions');
  expect(brief).toContain('Tool calls (2)');
  expect(brief).toContain('topic_read');
  expect(brief).toContain('topic_delete');
});

test('buildBrief surfaces a max-iterations stop as a warning', () => {
  const brief = buildBrief({ finalText: '', toolCalls: [], stopReason: 'max-iterations' });
  expect(brief).toContain('tool-call limit');
  expect(brief).toContain('No tool calls were made.');
});

test('buildBrief marks a deduped call as skipped (duplicate)', () => {
  const toolCalls: ToolCallRecord[] = [
    { name: 'workstream_create', args: { title: 'Foo' }, ok: true, destructive: false },
    { name: 'workstream_create', args: { title: 'Foo' }, ok: true, destructive: false, deduped: true },
  ];
  const brief = buildBrief({ finalText: 'Made it.', toolCalls, stopReason: 'final' });
  expect(brief).toContain('Tool calls (2)');
  expect(brief).toContain('skipped (duplicate)');
});

test('an unknown tool name resolves to { ok: false }', async () => {
  // 'bogus' short-circuits before touching the client, so a stub is fine.
  const executor = createControlPlaneToolExecutor({} as unknown as ControlPlaneClient);
  const res = await executor.execute('bogus', {});
  expect(res.ok).toBe(false);
  expect(res.error).toContain('unknown tool');
});

// --- host-side slug fallback -----------------------------------------------

/** A client stub that records the topicCreate/wsCreate input and reports no
 * existing slugs (so uniquify accepts the first candidate). */
function createStubClient(): {
  client: ControlPlaneClient;
  topicCreateArgs: Array<Record<string, unknown>>;
  wsCreateArgs: Array<Record<string, unknown>>;
} {
  const topicCreateArgs: Array<Record<string, unknown>> = [];
  const wsCreateArgs: Array<Record<string, unknown>> = [];
  const client = {
    async topicRead() {
      return [];
    },
    async wsRead() {
      return [];
    },
    async topicCreate(input: Record<string, unknown>) {
      topicCreateArgs.push(input);
      return { id: 'id-1', slug: input.slug, title: input.title };
    },
    async wsCreate(input: Record<string, unknown>) {
      wsCreateArgs.push(input);
      return { id: 'id-2', slug: input.slug, title: input.title };
    },
  } as unknown as ControlPlaneClient;
  return { client, topicCreateArgs, wsCreateArgs };
}

test('topic_create derives a slug from the title when the model omits it', async () => {
  const { client, topicCreateArgs } = createStubClient();
  const executor = createControlPlaneToolExecutor(client);
  const res = await executor.execute('topic_create', { title: 'Product Roadmap' });
  expect(res.ok).toBe(true);
  expect(topicCreateArgs[0].slug).toBe('product-roadmap');
});

test('topic_create normalizes a blank slug arg by deriving from the title', async () => {
  const { client, topicCreateArgs } = createStubClient();
  const executor = createControlPlaneToolExecutor(client);
  await executor.execute('topic_create', { title: 'My Cool Feature', slug: '   ' });
  expect(topicCreateArgs[0].slug).toBe('my-cool-feature');
});

test('topic_create normalizes a malformed provided slug', async () => {
  const { client, topicCreateArgs } = createStubClient();
  const executor = createControlPlaneToolExecutor(client);
  await executor.execute('topic_create', { title: 'X', slug: 'Product Roadmap!!' });
  expect(topicCreateArgs[0].slug).toBe('product-roadmap');
});

test('workstream_create also derives a slug from the title', async () => {
  const { client, wsCreateArgs } = createStubClient();
  const executor = createControlPlaneToolExecutor(client);
  await executor.execute('workstream_create', { title: 'Q3 Planning' });
  expect(wsCreateArgs[0].slug).toBe('q3-planning');
});

test('topic_create uniquifies when the derived slug already exists', async () => {
  const topicCreateArgs: Array<Record<string, unknown>> = [];
  const client = {
    async topicRead(input: { slug?: string }) {
      // The base slug is taken; the -2 variant is free.
      return input.slug === 'product-roadmap' ? [{ id: 'existing' }] : [];
    },
    async topicCreate(input: Record<string, unknown>) {
      topicCreateArgs.push(input);
      return { id: 'id', slug: input.slug, title: input.title };
    },
  } as unknown as ControlPlaneClient;
  const executor = createControlPlaneToolExecutor(client);
  await executor.execute('topic_create', { title: 'Product Roadmap' });
  expect(topicCreateArgs[0].slug).toBe('product-roadmap-2');
});

test('topic_create rejects when the title is empty (no slug derivable)', async () => {
  const { client } = createStubClient();
  const executor = createControlPlaneToolExecutor(client);
  const res = await executor.execute('topic_create', { body: 'orphan' });
  expect(res.ok).toBe(false);
  expect(res.error).toContain('title');
});

// --- brief sanitizer -------------------------------------------------------

test('stripToolScaffolding removes <tool_call> blocks and tool JSON', () => {
  const leaked =
    'Created the topic.<tool_call>{"name":"topic_create","arguments":{"title":"X"}}</tool_call> Done.';
  const clean = stripToolScaffolding(leaked);
  expect(clean).not.toContain('tool_call');
  expect(clean).not.toContain('topic_create');
  expect(clean).toContain('Created the topic.');
  expect(clean).toContain('Done.');
});

test('stripToolScaffolding removes an unclosed <tool_call> tail', () => {
  const leaked = 'Here is what I did.<tool_call>{"tool":"topic_read","args":{}}';
  expect(stripToolScaffolding(leaked)).toBe('Here is what I did.');
});

test('buildBrief falls back to the default summary when final text is pure scaffolding', () => {
  const brief = buildBrief({
    finalText: '<tool_call>{"name":"topic_read","arguments":{"slug":"x"}}</tool_call>',
    toolCalls: [],
    stopReason: 'final',
  });
  expect(brief).toContain('Done.');
  expect(brief).not.toContain('tool_call');
});
