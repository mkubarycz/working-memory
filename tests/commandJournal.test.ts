import { test, expect } from 'vitest';
import type { DocumentEnvelope } from '../src/controlPlaneClient';
import {
  GLOBAL_SCOPE_KEY,
  buildInitialJournalSpec,
  buildJournalSpec,
  filterAndSortJournals,
  journalsToHistory,
  journalsToTurns,
  parseJournalDoc,
  scopeKeyFor,
  type CommandJournalSpec,
} from '../src/commandJournal';

/** Build a stored CommandJournal envelope from a spec (store-shaped fake). */
function envelope(id: string, spec: CommandJournalSpec): DocumentEnvelope {
  return {
    kind: 'CommandJournal',
    metadata: {
      id,
      slug: null,
      labels: {},
      createdAt: 0,
      updatedAt: 0,
      deletedAt: null,
      resourceVersion: 1,
    },
    spec: spec as unknown as Record<string, unknown>,
    status: {},
  };
}

/** A minimal spec for one turn under `workstream` at timestamp `ts`. */
function spec(workstream: string, command: string, brief: string, ts: number): CommandJournalSpec {
  return {
    workstream,
    status: 'succeeded',
    request: { command, ts },
    response: { brief, toolCalls: [], corrections: [], stopReason: 'final' },
  };
}

test('scopeKeyFor returns the slug when present, the global sentinel otherwise', () => {
  expect(scopeKeyFor('product-roadmap')).toBe('product-roadmap');
  expect(scopeKeyFor('  spaced-slug  ')).toBe('spaced-slug');
  expect(scopeKeyFor(null)).toBe(GLOBAL_SCOPE_KEY);
  expect(scopeKeyFor(undefined)).toBe(GLOBAL_SCOPE_KEY);
  expect(scopeKeyFor('   ')).toBe(GLOBAL_SCOPE_KEY);
});

test('buildJournalSpec omits empty context fields', () => {
  const built = buildJournalSpec({
    workstream: 'ws',
    command: 'do it',
    contextSlug: '',
    contextKind: '   ',
    brief: 'done',
    toolCalls: [],
    corrections: [],
    stopReason: 'final',
    now: 1000,
  });
  expect(built.request).toEqual({ command: 'do it', ts: 1000 });
  expect(built.request.contextSlug).toBeUndefined();
  expect(built.request.contextKind).toBeUndefined();
  expect(built.response.tokens).toBeUndefined();
});

test('buildJournalSpec includes context fields and tokens when present', () => {
  const built = buildJournalSpec({
    workstream: 'ws',
    command: 'do it',
    contextSlug: 'my-topic',
    contextKind: 'topic',
    brief: 'done',
    toolCalls: [{ name: 'topic_read', args: {}, ok: true, destructive: false }],
    corrections: [],
    stopReason: 'final',
    tokens: { promptTokens: 12, evalTokens: 34, calls: 2 },
    now: 500,
  });
  expect(built.request).toEqual({
    command: 'do it',
    ts: 500,
    contextSlug: 'my-topic',
    contextKind: 'topic',
  });
  expect(built.response.tokens).toEqual({ promptTokens: 12, evalTokens: 34, calls: 2 });
  expect(built.response.toolCalls).toHaveLength(1);
});

test('buildJournalSpec carries timings when provided and omits them when absent', () => {
  const withTimings = buildJournalSpec({
    workstream: 'ws',
    command: 'do it',
    contextSlug: 'my-topic',
    contextKind: 'topic',
    brief: 'done',
    toolCalls: [],
    corrections: [],
    stopReason: 'final',
    timings: { totalMs: 4210, modelMs: 3800, modelCalls: 3, journalReadMs: 12, toolsMs: 398 },
    now: 500,
  });
  expect(withTimings.response.timings).toEqual({
    totalMs: 4210,
    modelMs: 3800,
    modelCalls: 3,
    journalReadMs: 12,
    toolsMs: 398,
  });

  const withoutTimings = buildJournalSpec({
    workstream: 'ws',
    command: 'do it',
    contextSlug: 'my-topic',
    contextKind: 'topic',
    brief: 'done',
    toolCalls: [],
    corrections: [],
    stopReason: 'final',
    now: 500,
  });
  expect(withoutTimings.response.timings).toBeUndefined();
});

test('buildInitialJournalSpec produces a running, request-only record', () => {
  const initial = buildInitialJournalSpec({
    workstream: 'ws',
    command: 'do it',
    contextSlug: 'my-topic',
    contextKind: 'topic',
    now: 1000,
  });
  expect(initial.status).toBe('running');
  expect(initial.request).toEqual({
    command: 'do it',
    ts: 1000,
    contextSlug: 'my-topic',
    contextKind: 'topic',
  });
  // The response is empty until the run finishes and phase 2 overwrites it.
  expect(initial.response).toEqual({
    brief: '',
    toolCalls: [],
    corrections: [],
    stopReason: 'running',
  });
});

test('buildInitialJournalSpec omits empty context fields like the final spec', () => {
  const initial = buildInitialJournalSpec({
    workstream: 'ws',
    command: 'do it',
    contextSlug: '',
    contextKind: '   ',
    now: 42,
  });
  expect(initial.request).toEqual({ command: 'do it', ts: 42 });
});

test('buildJournalSpec defaults status to succeeded and honors an explicit failed', () => {
  const ok = buildJournalSpec({
    workstream: 'ws',
    command: 'do it',
    contextSlug: null,
    contextKind: null,
    brief: 'done',
    toolCalls: [],
    corrections: [],
    stopReason: 'final',
    now: 1,
  });
  expect(ok.status).toBe('succeeded');

  const failed = buildJournalSpec({
    workstream: 'ws',
    command: 'do it',
    contextSlug: null,
    contextKind: null,
    brief: 'boom',
    toolCalls: [],
    corrections: [],
    stopReason: 'error',
    status: 'failed',
    now: 1,
  });
  expect(failed.status).toBe('failed');
  // The final spec carries the full response even on failure.
  expect(failed.response.brief).toBe('boom');
});

test('parseJournalDoc accepts a doc WITHOUT status (back-compat) and WITH status', () => {
  // A pre-two-phase envelope: spec never carried `status`.
  const legacy = envelope('legacy', spec('ws', 'ok', 'brief', 1));
  delete (legacy.spec as { status?: unknown }).status;
  expect((legacy.spec as { status?: unknown }).status).toBeUndefined();
  expect(parseJournalDoc(legacy)?.spec.workstream).toBe('ws');

  const modern = envelope('modern', { ...spec('ws', 'ok', 'brief', 2), status: 'running' });
  expect(parseJournalDoc(modern)?.spec.status).toBe('running');
});

test('parseJournalDoc accepts a doc without timings (back-compat)', () => {
  const legacy = envelope('legacy', spec('ws', 'ok', 'brief', 1));
  // The legacy spec helper writes no `timings` field at all.
  expect((legacy.spec as { response: { timings?: unknown } }).response.timings).toBeUndefined();
  const parsed = parseJournalDoc(legacy);
  expect(parsed?.spec.workstream).toBe('ws');
  expect(parsed?.spec.response.timings).toBeUndefined();
});

test('filterAndSortJournals filters by workstream and sorts oldest→newest, id tiebreak', () => {
  const docs = [
    envelope('b', spec('ws-a', 'third', 'c', 30)),
    envelope('a', spec('ws-a', 'first', 'a', 10)),
    envelope('other', spec('ws-b', 'ignored', 'x', 5)),
    // Two docs share ts=20 → id tiebreak (a2 before z2).
    envelope('z2', spec('ws-a', 'second-late', 'b2', 20)),
    envelope('a2', spec('ws-a', 'second-early', 'b1', 20)),
  ];
  const sorted = filterAndSortJournals(docs, 'ws-a');
  expect(sorted.map((d) => d.spec.request.command)).toEqual([
    'first',
    'second-early',
    'second-late',
    'third',
  ]);
});

test('journalsToTurns maps ordered docs to {id, command, brief} turns', () => {
  const docs = filterAndSortJournals(
    [
      envelope('a', spec('ws', 'one', 'brief-one', 1)),
      envelope('b', spec('ws', 'two', 'brief-two', 2)),
    ],
    'ws',
  );
  expect(journalsToTurns(docs)).toEqual([
    { id: 'a', command: 'one', brief: 'brief-one' },
    { id: 'b', command: 'two', brief: 'brief-two' },
  ]);
});

test('journalsToHistory caps to the last N turns', () => {
  const docs = filterAndSortJournals(
    [
      envelope('a', spec('ws', 'one', 'b1', 1)),
      envelope('b', spec('ws', 'two', 'b2', 2)),
      envelope('c', spec('ws', 'three', 'b3', 3)),
    ],
    'ws',
  );
  expect(journalsToHistory(docs, 2)).toEqual([
    { command: 'two', brief: 'b2' },
    { command: 'three', brief: 'b3' },
  ]);
  // No cap → all turns.
  expect(journalsToHistory(docs)).toHaveLength(3);
});

test('parseJournalDoc rejects malformed envelopes', () => {
  const good = envelope('good', spec('ws', 'ok', 'brief', 1));
  expect(parseJournalDoc(good)?.spec.workstream).toBe('ws');

  const noSpec = { ...good, spec: {} as Record<string, unknown> };
  expect(parseJournalDoc(noSpec)).toBeNull();

  const noWorkstream = { ...good, spec: { request: {}, response: {} } };
  expect(parseJournalDoc(noWorkstream)).toBeNull();

  const noRequest = { ...good, spec: { workstream: 'ws', response: {} } };
  expect(parseJournalDoc(noRequest)).toBeNull();
});
