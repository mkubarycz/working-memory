import { beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server';
import { openStore } from '../src/store';
import { clearKinds, validateSpec } from '../src/kinds/registry';
import { loadKinds } from '../src/kinds/loader';

let sqliteAvailable = true;
try {
  await import('node:sqlite');
} catch {
  sqliteAvailable = false;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content.find((item) => item.type === 'text')?.text ?? '';
}

function jsonOf<T>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

const baseCreate = {
  startedAt: 1_000,
  provider: { endpoint: 'http://127.0.0.1:11434', mode: 'local', model: 'qwen3:14b' },
  request: { userText: 'Update the selected topic.' },
  primaryScope: { kind: 'Topic', id: 'topic-1', slug: 'selected-topic', title: 'Selected topic' },
};

describe('CommandJournal schema', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('accepts the clean running shape and rejects unknown fields', () => {
    const valid = validateSpec('CommandJournal', {
      schemaVersion: 2,
      status: 'running',
      ...baseCreate,
      entityRefs: [],
      events: [],
    });
    expect(valid.schemaVersion).toBe(2);
    expect(() => validateSpec('CommandJournal', { ...valid, threadId: 'not-supported' })).toThrow();
  });

  it('rejects oversized or credential-bearing sanitized payloads and credentialed endpoints', () => {
    const spec = {
      schemaVersion: 2,
      status: 'running',
      ...baseCreate,
      entityRefs: [],
      events: [
        { id: 'turn-1', sequence: 1, timestamp: 1_001, type: 'model_turn', role: 'assistant', iteration: 1, assistantText: '', durationMs: 1 },
        { id: 'call-1', sequence: 2, timestamp: 1_002, type: 'tool_call', modelTurnId: 'turn-1', callId: 'c1', toolName: 'ws-topic-read', arguments: { token: 'secret' } },
      ],
    };
    expect(() => validateSpec('CommandJournal', spec)).toThrow(/credential/i);
    expect(() => validateSpec('CommandJournal', {
      ...spec,
      events: [spec.events[0], { ...spec.events[1], arguments: { body: 'x'.repeat(70_000) } }],
    })).toThrow(/65536/);
    expect(() => validateSpec('CommandJournal', {
      ...spec,
      provider: { ...baseCreate.provider, endpoint: 'https://user:pass@example.test' },
      events: [],
    })).toThrow(/credentials/i);
    expect(() => validateSpec('CommandJournal', {
      ...spec,
      provider: { ...baseCreate.provider, endpoint: 'https://example.test?api_token=secret' },
      events: [],
    })).toThrow(/credentials/i);
  });

  it('accepts the full canonical event shapes', () => {
    const valid = validateSpec('CommandJournal', {
      schemaVersion: 2,
      status: 'running',
      ...baseCreate,
      entityRefs: [],
      events: [
        {
          id: 'turn-1', sequence: 1, timestamp: 1_001, type: 'model_turn', role: 'assistant', iteration: 1,
          assistantText: 'Checking.', contentParts: [{ type: 'reasoning', text: 'Inspect state.' }, { type: 'text', text: 'Checking.' }],
          providerResponseId: 'response-1', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, durationMs: 25,
        },
        { id: 'call-1', sequence: 2, timestamp: 1_002, type: 'tool_call', modelTurnId: 'turn-1', callId: 'c1', toolName: 'ws-topic-read', argumentParseError: 'Malformed JSON at byte 4' },
        { id: 'result-1', sequence: 3, timestamp: 1_003, type: 'tool_result', callId: 'c1', status: 'cancelled', error: { message: 'Cancelled by operator' }, durationMs: 2 },
        { id: 'turn-2', sequence: 4, timestamp: 1_004, type: 'model_turn', role: 'system', iteration: 2, durationMs: 3 },
        { id: 'call-2', sequence: 5, timestamp: 1_005, type: 'tool_call', modelTurnId: 'turn-2', callId: 'c2', toolName: 'ws-topic-update', arguments: { slug: 'selected-topic' } },
        { id: 'confirm-1', sequence: 6, timestamp: 1_006, type: 'confirmation_requested', confirmationId: 'approval-1', callId: 'c2', prompt: 'Proceed?' },
        { id: 'confirm-2', sequence: 7, timestamp: 1_007, type: 'confirmation_resolved', confirmationId: 'approval-1', callId: 'c2', resolution: 'approved' },
        { id: 'result-2', sequence: 8, timestamp: 1_008, type: 'tool_result', callId: 'c2', status: 'success', result: { updated: true }, durationMs: 12 },
        { id: 'error-1', sequence: 9, timestamp: 1_009, type: 'run_error', stage: 'completion', message: 'Completion rendering failed', details: { reason: 'invalid target' } },
      ],
    });
    expect(valid.events).toHaveLength(9);
  });

  it('rejects invalid tool argument, result, and confirmation combinations', () => {
    const validateEvents = (events: unknown[]) => validateSpec('CommandJournal', {
      schemaVersion: 2, status: 'running', ...baseCreate, entityRefs: [], events,
    });
    const turn = { id: 'turn-1', sequence: 1, timestamp: 1_001, type: 'model_turn', role: 'assistant', iteration: 1, assistantText: '', durationMs: 1 };
    expect(() => validateEvents([turn, { id: 'call-1', sequence: 2, timestamp: 1_002, type: 'tool_call', modelTurnId: 'turn-1', callId: 'c1', toolName: 'x' }])).toThrow(/exactly one/);
    expect(() => validateEvents([turn, { id: 'call-1', sequence: 2, timestamp: 1_002, type: 'tool_call', modelTurnId: 'turn-1', callId: 'c1', toolName: 'x', arguments: {}, argumentParseError: 'bad' }])).toThrow(/exactly one/);
    const call = { id: 'call-1', sequence: 2, timestamp: 1_002, type: 'tool_call', modelTurnId: 'turn-1', callId: 'c1', toolName: 'x', arguments: {} };
    expect(() => validateEvents([turn, call, { id: 'result-1', sequence: 3, timestamp: 1_003, type: 'tool_result', callId: 'c1', status: 'failure', durationMs: 1 }])).toThrow(/requires error/);
    expect(() => validateEvents([turn, call, { id: 'result-1', sequence: 3, timestamp: 1_003, type: 'tool_result', callId: 'c1', status: 'cancelled', result: {}, durationMs: 1 }])).toThrow(/cannot include result/);
    const requested = { id: 'confirm-1', sequence: 3, timestamp: 1_003, type: 'confirmation_requested', confirmationId: 'approval-1', callId: 'c1', prompt: 'Proceed?' };
    expect(() => validateEvents([turn, call, requested, { id: 'confirm-2', sequence: 4, timestamp: 1_004, type: 'confirmation_resolved', confirmationId: 'approval-1', resolution: 'rejected' }])).toThrow(/must match/);
  });
});

(sqliteAvailable ? describe : describe.skip)('CommandJournal ws-commandjournal-* API', () => {
  beforeAll(async () => {
    clearKinds();
    await loadKinds();
  });

  it('exposes create, append, and finalize tools', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'commandjournal-catalog-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'ws-commandjournal-read',
          'ws-commandjournal-create',
          'ws-commandjournal-append',
          'ws-commandjournal-finalize',
        ]),
      );
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('creates, atomically appends, and finalizes a journal', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'commandjournal-happy-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    try {
      const created = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-create', arguments: { ...baseCreate, entityRefs: [{ kind: 'Topic', id: 'topic-1', slug: 'selected-topic', relation: 'referenced' }] } }));
      expect(created).toMatchObject({ schemaVersion: 2, status: 'running', events: [], resourceVersion: 1 });

      const appended = jsonOf<any>(await client.callTool({
        name: 'ws-commandjournal-append',
        arguments: {
          id: created.id,
          expectedResourceVersion: created.resourceVersion,
          events: [
            { id: 'turn-1', sequence: 1, timestamp: 1_010, type: 'model_turn', role: 'assistant', iteration: 1, assistantText: 'Reading.', durationMs: 20 },
            { id: 'call-event-1', sequence: 2, timestamp: 1_011, type: 'tool_call', modelTurnId: 'turn-1', callId: 'call-1', toolName: 'ws-topic-read', arguments: { slug: 'selected-topic' } },
            { id: 'result-1', sequence: 3, timestamp: 1_012, type: 'tool_result', callId: 'call-1', status: 'success', result: { count: 1 }, durationMs: 5 },
          ],
          entityRefs: [
            { kind: 'Topic', id: 'topic-1', title: 'Selected topic', relation: 'referenced' },
            { kind: 'Workstream', id: 'workstream-1', relation: 'mutated' },
            { kind: 'Topic', id: 'topic-1', relation: 'mutated' },
          ],
        },
      }));
      expect(appended.events.map((event: any) => event.sequence)).toEqual([1, 2, 3]);
      expect(appended.entityRefs).toEqual([
        { kind: 'Topic', id: 'topic-1', slug: 'selected-topic', title: 'Selected topic', relation: 'referenced' },
        { kind: 'Workstream', id: 'workstream-1', relation: 'mutated' },
        { kind: 'Topic', id: 'topic-1', relation: 'mutated' },
      ]);
      expect(appended.resourceVersion).toBe(2);

      const overflow = await client.callTool({
        name: 'ws-commandjournal-append',
        arguments: {
          id: created.id,
          expectedResourceVersion: appended.resourceVersion,
          events: [{ id: 'error-1', sequence: 4, timestamp: 1_013, type: 'run_error', stage: 'execution', message: 'x' }],
          entityRefs: Array.from({ length: 498 }, (_, index) => ({ kind: 'Topic', id: `extra-${index}`, relation: 'referenced' })),
        },
      });
      expect(isError(overflow)).toBe(true);
      expect(textOf(overflow)).toMatch(/500/);
      expect(store.getDocument({ id: created.id })?.metadata.resourceVersion).toBe(2);

      const finalized = jsonOf<any>(await client.callTool({
        name: 'ws-commandjournal-finalize',
        arguments: {
          id: created.id,
          expectedResourceVersion: appended.resourceVersion,
          status: 'succeeded',
          completedAt: 1_100,
          completion: { finalAssistantText: 'Updated.', stopReason: 'stop', mutated: true, navigationTarget: baseCreate.primaryScope },
          entityRefs: [{ kind: 'Workstream', id: 'workstream-1', slug: 'active-work', relation: 'mutated' }],
        },
      }));
      expect(finalized).toMatchObject({ status: 'succeeded', completedAt: 1_100, completion: { finalAssistantText: 'Updated.', mutated: true }, resourceVersion: 3 });
      expect(finalized.entityRefs).toEqual([
        { kind: 'Topic', id: 'topic-1', slug: 'selected-topic', title: 'Selected topic', relation: 'referenced' },
        { kind: 'Workstream', id: 'workstream-1', slug: 'active-work', relation: 'mutated' },
        { kind: 'Topic', id: 'topic-1', relation: 'mutated' },
      ]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('rejects stale CAS, invalid sequence/linkage, and unsafe lifecycle transitions without partial writes', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'commandjournal-rejection-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    try {
      const created = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-create', arguments: baseCreate }));
      const stale = await client.callTool({ name: 'ws-commandjournal-append', arguments: { id: created.id, expectedResourceVersion: 0, events: [{ id: 'e1', sequence: 1, timestamp: 1_001, type: 'run_error', stage: 'execution', message: 'x' }] } });
      expect(isError(stale)).toBe(true);
      expect(textOf(stale)).toMatch(/Conflict/);

      const badSequence = await client.callTool({ name: 'ws-commandjournal-append', arguments: { id: created.id, expectedResourceVersion: 1, events: [{ id: 'e2', sequence: 2, timestamp: 1_002, type: 'run_error', stage: 'execution', message: 'x' }] } });
      expect(isError(badSequence)).toBe(true);
      expect(textOf(badSequence)).toMatch(/sequence must be 1/);

      const badLink = await client.callTool({ name: 'ws-commandjournal-append', arguments: { id: created.id, expectedResourceVersion: 1, events: [{ id: 'r1', sequence: 1, timestamp: 1_003, type: 'tool_result', callId: 'missing', status: 'success', durationMs: 1 }] } });
      expect(isError(badLink)).toBe(true);
      expect(textOf(badLink)).toMatch(/earlier tool_call/);
      expect(store.getDocument({ id: created.id })?.metadata.resourceVersion).toBe(1);

      const awaiting = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-append', arguments: { id: created.id, expectedResourceVersion: 1, events: [{ id: 'confirm-1', sequence: 1, timestamp: 1_004, type: 'confirmation_requested', confirmationId: 'approval-1', prompt: 'Proceed?' }] } }));
      expect(awaiting.status).toBe('awaiting_confirmation');
      const unresolvedFinalize = await client.callTool({ name: 'ws-commandjournal-finalize', arguments: { id: created.id, expectedResourceVersion: awaiting.resourceVersion, status: 'cancelled', completedAt: 1_050, completion: { finalAssistantText: '', stopReason: 'cancelled', mutated: false } } });
      expect(isError(unresolvedFinalize)).toBe(true);
      expect(textOf(unresolvedFinalize)).toMatch(/unresolved confirmation/);
      const resolved = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-append', arguments: { id: created.id, expectedResourceVersion: awaiting.resourceVersion, events: [{ id: 'confirm-2', sequence: 2, timestamp: 1_005, type: 'confirmation_resolved', confirmationId: 'approval-1', resolution: 'cancelled' }] } }));
      expect(resolved.status).toBe('running');

      const finalized = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-finalize', arguments: { id: created.id, expectedResourceVersion: resolved.resourceVersion, status: 'cancelled', completedAt: 1_100, completion: { finalAssistantText: '', stopReason: 'cancelled', mutated: false } } }));
      const afterTerminal = await client.callTool({ name: 'ws-commandjournal-append', arguments: { id: created.id, expectedResourceVersion: finalized.resourceVersion, events: [{ id: 'late', sequence: 1, timestamp: 1_200, type: 'run_error', stage: 'execution', message: 'late' }] } });
      expect(isError(afterTerminal)).toBe(true);
      expect(textOf(afterTerminal)).toMatch(/terminal/);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('pages stable newest-first summaries with deterministic ties and no payload leakage', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'commandjournal-history-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    try {
      const ids: string[] = [];
      for (const userText of ['one', 'two', 'three']) {
        const created = jsonOf<any>(await client.callTool({
          name: 'ws-commandjournal-create',
          arguments: {
            ...baseCreate,
            request: { userText },
            entityRefs: [{ kind: 'Workstream', id: 'workstream-1', relation: userText === 'two' ? 'mutated' : 'referenced' }],
          },
        }));
        ids.push(created.id);
      }

      const withPayloads = jsonOf<any>(await client.callTool({
        name: 'ws-commandjournal-append',
        arguments: {
          id: ids[1],
          expectedResourceVersion: 2,
          events: [
            { id: 'turn-1', sequence: 1, timestamp: 1_001, type: 'model_turn', role: 'assistant', iteration: 1, assistantText: 'Checking.', durationMs: 1 },
            { id: 'call-1', sequence: 2, timestamp: 1_002, type: 'tool_call', modelTurnId: 'turn-1', callId: 'c1', toolName: 'ws-topic-read', arguments: { privateArgument: 'omit-me' } },
            { id: 'result-1', sequence: 3, timestamp: 1_003, type: 'tool_result', callId: 'c1', status: 'success', result: { privateResult: 'omit-me' }, durationMs: 1 },
          ],
        },
      }));
      expect(withPayloads.resourceVersion).toBe(4);

      const first = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-read', arguments: { limit: 2 } }));
      const expectedOrder = [...ids].reverse();
      expect(first.journals.map((journal: any) => journal.id)).toEqual(expectedOrder.slice(0, 2));
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(JSON.stringify(first.journals)).not.toContain('privateArgument');
      expect(JSON.stringify(first.journals)).not.toContain('privateResult');
      const toolSummary = first.journals.flatMap((journal: any) => journal.eventSummaries)[0];
      expect(toolSummary).toMatchObject({ toolName: 'ws-topic-read', callId: 'c1', status: 'success' });

      const inserted = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-create', arguments: { ...baseCreate, request: { userText: 'newer' } } }));
      const finalizedOldest = jsonOf<any>(await client.callTool({
        name: 'ws-commandjournal-finalize',
        arguments: {
          id: ids[0],
          expectedResourceVersion: 1,
          status: 'succeeded',
          completedAt: 1_100,
          completion: { finalAssistantText: 'Finished later.', stopReason: 'stop', mutated: false },
        },
      }));
      expect(finalizedOldest.resourceVersion).toBeGreaterThan(inserted.resourceVersion);
      const second = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-read', arguments: { limit: 2, cursor: first.nextCursor } }));
      expect(second.journals.map((journal: any) => journal.id)).toEqual(expectedOrder.slice(2));
      expect(second.journals[0]).toMatchObject({ status: 'succeeded', completedAt: 1_100 });
      expect([...first.journals, ...second.journals].map((journal: any) => journal.id)).not.toContain(inserted.id);
      expect(new Set([...first.journals, ...second.journals].map((journal: any) => journal.id)).size).toBe(3);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('filters summaries, includes running records, rejects bad cursors, and returns full by-id detail', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'commandjournal-filter-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    try {
      const matching = jsonOf<any>(await client.callTool({
        name: 'ws-commandjournal-create',
        arguments: {
          ...baseCreate,
          entityRefs: [{ kind: 'Workstream', id: 'workstream-1', relation: 'mutated' }],
        },
      }));
      const other = jsonOf<any>(await client.callTool({
        name: 'ws-commandjournal-create',
        arguments: {
          ...baseCreate,
          primaryScope: { kind: 'Workstream', id: 'workstream-2' },
          entityRefs: [{ kind: 'Workstream', id: 'workstream-1', relation: 'referenced' }],
        },
      }));

      const scopeFiltered = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-read', arguments: { primaryScope: { kind: 'Topic', id: 'topic-1' } } }));
      expect(scopeFiltered.journals.map((journal: any) => journal.id)).toEqual([matching.id]);
      expect(scopeFiltered.journals[0]).toMatchObject({ status: 'running' });
      expect(scopeFiltered.journals[0]).not.toHaveProperty('completedAt');

      const relationFiltered = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-read', arguments: { entityRef: { kind: 'Workstream', id: 'workstream-1', relation: 'mutated' } } }));
      expect(relationFiltered.journals.map((journal: any) => journal.id)).toEqual([matching.id]);

      const malformed = await client.callTool({ name: 'ws-commandjournal-read', arguments: { cursor: 'not+a+cursor' } });
      expect(isError(malformed)).toBe(true);
      expect(textOf(malformed)).toMatch(/Malformed cursor/);

      const detail = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-read', arguments: { id: matching.id } }));
      expect(detail.journal).toMatchObject({ id: matching.id, events: [], provider: baseCreate.provider });

      store.deleteDocument({ id: other.id });
      const all = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-read', arguments: {} }));
      expect(all.journals.map((journal: any) => journal.id)).toEqual([matching.id]);
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });

  it('ignores legacy CommandJournal rows in v2 reads', async () => {
    const store = openStore(':memory:');
    const server = await startServer({ port: 0, store });
    const client = new Client({ name: 'commandjournal-legacy-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`)));
    try {
      const current = jsonOf<any>(await client.callTool({
        name: 'ws-commandjournal-create',
        arguments: { ...baseCreate },
      }));
      const legacy = jsonOf<any>(await client.callTool({
        name: 'ws-commandjournal-create',
        arguments: { ...baseCreate, request: { userText: 'legacy' } },
      }));
      store.db.prepare('UPDATE resources SET spec = ? WHERE id = ?').run(
        JSON.stringify({ status: 'succeeded', request: 'legacy' }),
        legacy.id,
      );

      const history = jsonOf<any>(await client.callTool({ name: 'ws-commandjournal-read', arguments: {} }));
      expect(history.journals.map((journal: any) => journal.id)).toEqual([current.id]);

      const detail = jsonOf<any>(await client.callTool({
        name: 'ws-commandjournal-read',
        arguments: { id: legacy.id },
      }));
      expect(detail.journal).toBeNull();
    } finally {
      await client.close();
      await server.close();
      store.close();
    }
  });
});