import { test, expect, vi } from 'vitest';
import {
  buildBrief,
  createControlPlaneToolExecutor,
  stripToolScaffolding,
} from '../src/wmToolExecutor';
import type { ControlPlaneClient, ToolCallOutcome } from '../src/controlPlaneClient';
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

// --- generic dispatch ------------------------------------------------------

/** The reverse map the projection hands the executor for these tests. */
function reverseMap(): Map<string, string> {
  return new Map<string, string>([
    ['topic_read', 'ws-topic-read'],
    ['topic_create', 'ws-topic-create'],
    ['topic_delete', 'ws-topic-delete'],
    ['document_delete', 'wm-document-delete'],
  ]);
}

/** A client stub whose `callTool` returns a canned outcome and records the call. */
function stubClient(outcome: ToolCallOutcome): {
  client: ControlPlaneClient;
  callTool: ReturnType<typeof vi.fn>;
} {
  const callTool = vi.fn(async () => outcome);
  const client = { callTool } as unknown as ControlPlaneClient;
  return { client, callTool };
}

test('an unknown local tool name resolves to { ok: false } without calling the client', async () => {
  const { client, callTool } = stubClient({ ok: true });
  const executor = createControlPlaneToolExecutor(client, reverseMap());
  const res = await executor.execute('bogus', {});
  expect(res.ok).toBe(false);
  expect(res.error).toContain('unknown tool');
  expect(callTool).not.toHaveBeenCalled();
});

test('dispatch maps the local name to the canonical name and forwards cleaned args', async () => {
  const { client, callTool } = stubClient({ ok: true, result: { slug: 'roadmap' } });
  const executor = createControlPlaneToolExecutor(client, reverseMap());
  const res = await executor.execute('topic_create', {
    title: 'Roadmap',
    slug: '   ', // blank → dropped by cleanArgs
    body: undefined, // nullish → dropped
  });
  expect(res.ok).toBe(true);
  expect(res.result).toEqual({ slug: 'roadmap' });
  expect(callTool).toHaveBeenCalledWith('ws-topic-create', { title: 'Roadmap' });
});

test('a tool-level rejection maps to { ok: false, error }', async () => {
  const { client } = stubClient({ ok: false, error: 'slug already exists' });
  const executor = createControlPlaneToolExecutor(client, reverseMap());
  const res = await executor.execute('topic_create', { title: 'X', slug: 'x' });
  expect(res.ok).toBe(false);
  expect(res.error).toBe('slug already exists');
});

test('a -delete tool is flagged destructive on success', async () => {
  const { client, callTool } = stubClient({ ok: true, result: { ok: true } });
  const executor = createControlPlaneToolExecutor(client, reverseMap());
  const res = await executor.execute('topic_delete', { slug: 'foo' });
  expect(res.ok).toBe(true);
  expect(res.destructive).toBe(true);
  expect(callTool).toHaveBeenCalledWith('ws-topic-delete', { slug: 'foo' });
});

test('the generic wm-document-delete is reachable and flagged destructive', async () => {
  const { client, callTool } = stubClient({ ok: true, result: { ok: true } });
  const executor = createControlPlaneToolExecutor(client, reverseMap());
  const res = await executor.execute('document_delete', { id: 'doc-1' });
  expect(res.ok).toBe(true);
  expect(res.destructive).toBe(true);
  expect(callTool).toHaveBeenCalledWith('wm-document-delete', { id: 'doc-1' });
});

test('a non-delete tool is NOT flagged destructive', async () => {
  const { client } = stubClient({ ok: true, result: [] });
  const executor = createControlPlaneToolExecutor(client, reverseMap());
  const res = await executor.execute('topic_read', {});
  expect(res.ok).toBe(true);
  expect(res.destructive).toBeUndefined();
});

test('an unexpected throw from callTool is caught as { ok: false }', async () => {
  const callTool = vi.fn(async () => {
    throw new Error('boom');
  });
  const client = { callTool } as unknown as ControlPlaneClient;
  const executor = createControlPlaneToolExecutor(client, reverseMap());
  const res = await executor.execute('topic_read', {});
  expect(res.ok).toBe(false);
  expect(res.error).toBe('boom');
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
