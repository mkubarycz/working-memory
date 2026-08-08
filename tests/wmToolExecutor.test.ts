import { test, expect } from 'vitest';
import {
  buildBrief,
  createControlPlaneToolExecutor,
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
