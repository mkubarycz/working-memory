/**
 * WM 14.2.1: unit coverage for the generic fallback view-model builder and its
 * `asString` helper. Pure logic — the `vscode` module is mocked only so the
 * provider imports.
 */

import { describe, test, expect, vi } from 'vitest';
import type { DocumentEnvelope } from '../src/controlPlaneClient';

vi.mock('vscode', () => {
  class EventEmitter<T> {
    get event() {
      return (_l: (e: T) => void) => ({ dispose: () => {} });
    }
    fire(): void {}
  }
  return { EventEmitter, Uri: { parse: (v: string) => ({ path: v }) } };
});

function envelope(
  spec: Record<string, unknown>,
  metadata: Partial<DocumentEnvelope['metadata']> = {},
): DocumentEnvelope {
  return {
    kind: 'Nanite',
    metadata: {
      id: 'id-1',
      slug: 'slug-1',
      labels: {},
      createdAt: 1,
      updatedAt: 2,
      deletedAt: null,
      resourceVersion: 3,
      ...metadata,
    },
    spec,
    status: {},
  };
}

describe('asString', () => {
  test('coerces null/undefined to an empty string', async () => {
    const { asString } = await import('../src/webview/documentEditorProvider');
    expect(asString(null)).toBe('');
    expect(asString(undefined)).toBe('');
  });

  test('passes strings through unchanged', async () => {
    const { asString } = await import('../src/webview/documentEditorProvider');
    expect(asString('hello')).toBe('hello');
  });

  test('JSON-stringifies objects (pretty-printed)', async () => {
    const { asString } = await import('../src/webview/documentEditorProvider');
    expect(asString({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(asString([1, 2])).toBe(JSON.stringify([1, 2], null, 2));
  });

  test('stringifies other primitives', async () => {
    const { asString } = await import('../src/webview/documentEditorProvider');
    expect(asString(42)).toBe('42');
    expect(asString(true)).toBe('true');
  });
});

describe('buildGenericVM', () => {
  test('title falls back spec.title → spec.label → slug → id', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    expect(buildGenericVM(envelope({ title: 'T', label: 'L' })).title).toBe('T');
    expect(buildGenericVM(envelope({ label: 'L' })).title).toBe('L');
    expect(buildGenericVM(envelope({})).title).toBe('slug-1');
    expect(
      buildGenericVM(envelope({}, { slug: null })).title,
    ).toBe('id-1');
  });

  test('flattens spec values via asString (objects → JSON, primitives pass through)', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    const vm = buildGenericVM(envelope({ count: 7, meta: { a: 1 } }));
    const byKey = Object.fromEntries(vm.spec.map((f) => [f.key, f.value]));
    expect(byKey.count).toBe('7');
    expect(byKey.meta).toBe(JSON.stringify({ a: 1 }, null, 2));
  });

  test('sorts spec fields by key', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    const vm = buildGenericVM(envelope({ zeta: 1, alpha: 2, mid: 3 }));
    expect(vm.spec.map((f) => f.key)).toEqual(['alpha', 'mid', 'zeta']);
  });

  test('drops legacy run-remnant keys from a Nanite doc, keeping desired state', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    const vm = buildGenericVM(
      envelope({
        request: 'Build it',
        configs: ['env'],
        templateId: 'tpl',
        phase: 'Succeeded',
        // Legacy run remnants that must NOT surface on the nanite page.
        output: 'old run output',
        steps: [{ kind: 'assistant', text: 'x' }],
        acceptance: { passed: true },
        toolCalls: [{ name: 't', ok: true }],
        tokens: { total_tokens: 5 },
        missingTools: ['ws-gone'],
        iterations: 3,
        hitIterationCap: false,
        prompt: 'old prompt',
      }),
    );
    const keys = vm.spec.map((f) => f.key);
    expect(keys).toEqual(['configs', 'phase', 'request', 'templateId']);
  });

  test('keeps run-remnant-named keys on NON-Nanite docs (filter is nanite-scoped)', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    // The shared envelope() hardcodes kind 'Nanite'; re-tag to a generic kind
    // to prove the remnant filter only applies to nanites.
    const generic = buildGenericVM({
      ...envelope({ output: 'keep me', request: 'r' }),
      kind: 'CommandJournal',
    });
    expect(generic.spec.map((f) => f.key)).toEqual(['output', 'request']);
  });

  test('carries the envelope kind + metadata through', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    const vm = buildGenericVM(envelope({}));
    expect(vm).toMatchObject({
      kind: 'Nanite',
      id: 'id-1',
      slug: 'slug-1',
      createdAt: 1,
      updatedAt: 2,
      resourceVersion: 3,
    });
  });

  test('tolerates a missing spec', async () => {
    const { buildGenericVM } = await import(
      '../src/webview/documentEditorProvider'
    );
    const env = envelope({});
    // Simulate an envelope with no spec at all.
    (env as { spec?: unknown }).spec = undefined;
    const vm = buildGenericVM(env);
    expect(vm.spec).toEqual([]);
    expect(vm.title).toBe('slug-1');
  });
});

describe('hashVm', () => {
  test('same VM hashes identically; a field change changes the hash', async () => {
    const { buildGenericVM, hashVm } = await import(
      '../src/webview/documentEditorProvider'
    );
    const a = buildGenericVM(envelope({ status: 'open' }));
    const b = buildGenericVM(envelope({ status: 'open' }));
    const c = buildGenericVM(envelope({ status: 'closed' }));
    expect(hashVm(a)).toBe(hashVm(b));
    expect(hashVm(a)).not.toBe(hashVm(c));
  });
});

interface JournalOverrides {
  id?: string;
  outcome?: 'succeeded' | 'failed' | null;
  phase?: string;
  summary?: string;
  error?: string;
  startedAt?: number | null;
  endedAt?: number | null;
  created_at?: number;
}

/** Minimal NaniteJournal factory for projection tests. */
function journal(o: JournalOverrides = {}): import('../src/controlPlaneClient').NaniteJournal {
  return {
    id: o.id ?? 'j-1',
    slug: null,
    naniteId: 'nan-1',
    workstream: 'ws',
    inputTopic: '',
    status: {
      phase: (o.phase ?? 'Succeeded') as never,
      outcome: o.outcome === undefined ? 'succeeded' : o.outcome,
      queuedAt: null,
      startedAt: o.startedAt === undefined ? 100 : o.startedAt,
      endedAt: o.endedAt === undefined ? 103 : o.endedAt,
    },
    prompt: { request: 'do it' },
    execution: { steps: [], error: o.error ?? '' },
    results: {
      summary: o.summary ?? '',
      acceptance: null,
      tokens: null,
      missingTools: [],
    },
    created_at: o.created_at ?? 50,
    updated_at: 60,
    resourceVersion: 1,
  };
}

describe('projectNaniteJournals', () => {
  test('orders newest-first by end time (falling back to start, then created)', async () => {
    const { projectNaniteJournals } = await import(
      '../src/webview/documentEditorProvider'
    );
    const rows = projectNaniteJournals([
      journal({ id: 'old', endedAt: 100 }),
      journal({ id: 'new', endedAt: 300 }),
      journal({ id: 'mid', endedAt: 200 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
  });

  test('maps outcome, phase, summary, and duration', async () => {
    const { projectNaniteJournals } = await import(
      '../src/webview/documentEditorProvider'
    );
    const [row] = projectNaniteJournals([
      journal({ outcome: 'succeeded', phase: 'Succeeded', summary: 'Built the thing', startedAt: 10, endedAt: 13 }),
    ]);
    expect(row).toMatchObject({
      outcome: 'succeeded',
      phase: 'Succeeded',
      summary: 'Built the thing',
      endedAt: 13,
      duration: '3s',
    });
  });

  test('falls back to the error text when a failed run has no summary', async () => {
    const { projectNaniteJournals } = await import(
      '../src/webview/documentEditorProvider'
    );
    const [row] = projectNaniteJournals([
      journal({ outcome: 'failed', phase: 'Failed', summary: '', error: 'boom: missing tool' }),
    ]);
    expect(row.outcome).toBe('failed');
    expect(row.summary).toBe('boom: missing tool');
  });

  test('formats multi-minute durations and omits duration when timing is unknown', async () => {
    const { projectNaniteJournals } = await import(
      '../src/webview/documentEditorProvider'
    );
    const [long, unknown] = projectNaniteJournals([
      journal({ id: 'long', startedAt: 4, endedAt: 68 }),
      journal({ id: 'unknown', startedAt: null, endedAt: null, created_at: 1 }),
    ]);
    // Newest-first: `long` (endedAt 68) sorts before `unknown` (fallback 1).
    expect(long.duration).toBe('1m 4s');
    expect(unknown.duration).toBe('');
  });

  test('clips a long summary to a single line', async () => {
    const { projectNaniteJournals } = await import(
      '../src/webview/documentEditorProvider'
    );
    const [row] = projectNaniteJournals([
      journal({ summary: 'line one\n   line two   with   spaces\nline three' }),
    ]);
    expect(row.summary).toBe('line one line two with spaces line three');
  });
});

/** Minimal Nanite factory for detail-projection tests. */
function nanite(
  o: Partial<import('../src/controlPlaneClient').Nanite> = {},
): import('../src/controlPlaneClient').Nanite {
  return {
    id: 'nan-1',
    slug: null,
    templateId: 'tpl-slug',
    workstream: 'ws',
    inputTopic: '',
    configs: [],
    request: 'Build the thing',
    phase: 'Succeeded',
    queuedAt: null,
    startedAt: 10,
    endedAt: 13,
    error: '',
    latestJournalId: 'j-1',
    created_at: 5,
    updated_at: 15,
    resourceVersion: 1,
    ...o,
  };
}

/** Minimal NaniteTemplate factory for detail-projection tests. */
function template(
  o: Partial<import('../src/controlPlaneClient').NaniteTemplate> = {},
): import('../src/controlPlaneClient').NaniteTemplate {
  return {
    id: 'tpl-1',
    slug: 'tpl-slug',
    title: 'Developer',
    triggerPhrase: '',
    instructions: '',
    executionSettings: {},
    toolAllowlist: [],
    toolDenylist: [],
    allowRunWithoutHuman: false,
    inputSchema: {},
    outputSchema: {},
    acceptanceCriteria: '',
    acceptanceThreshold: 0.7,
    enabled: true,
    created_at: 1,
    updated_at: 1,
    resourceVersion: 1,
    ...o,
  };
}

describe('projectNaniteJournalDetail', () => {
  test('maps status, prompt, results, and acceptance', async () => {
    const { projectNaniteJournalDetail } = await import(
      '../src/webview/documentEditorProvider'
    );
    const j = journal({ startedAt: 10, endedAt: 13, summary: 'Did the work' });
    j.results.acceptance = { summary: 'Looks good', confidence: 0.9, threshold: 0.7, passed: true };
    const vm = projectNaniteJournalDetail(j, nanite(), template());
    expect(vm).toMatchObject({
      outcome: 'succeeded',
      phase: 'Succeeded',
      startedAt: 10,
      endedAt: 13,
      duration: '3s',
      request: 'do it',
      summary: 'Did the work',
    });
    expect(vm.acceptance).toEqual({
      summary: 'Looks good',
      confidence: 0.9,
      threshold: 0.7,
      passed: true,
    });
  });

  test('acceptance verdict drives the single top callout (accepted)', async () => {
    const { projectNaniteJournalDetail } = await import(
      '../src/webview/documentEditorProvider'
    );
    const j = journal({ summary: 'Did the work' });
    j.results.acceptance = { summary: 'Looks good', confidence: 0.9, threshold: 0.7, passed: true };
    const vm = projectNaniteJournalDetail(j, nanite(), template());
    expect(vm.callout).toEqual({
      variant: 'accepted',
      verdict: 'Accepted',
      score: 'confidence 0.9 · threshold 0.7',
      reason: 'Looks good',
    });
  });

  test('rejected acceptance folds reason + score into the top callout', async () => {
    const { projectNaniteJournalDetail } = await import(
      '../src/webview/documentEditorProvider'
    );
    // Runner sets a redundant execution error on rejection; the callout must
    // prefer the acceptance verdict so the low card can be dropped.
    const j = journal({ outcome: 'failed', error: 'Acceptance Criteria Not Matched' });
    j.results.acceptance = { summary: 'Missed the mark', confidence: 0.4, threshold: 0.7, passed: false };
    const vm = projectNaniteJournalDetail(j, nanite(), template());
    expect(vm.callout).toEqual({
      variant: 'rejected',
      verdict: 'Rejected',
      score: 'confidence 0.4 · threshold 0.7',
      reason: 'Missed the mark',
    });
  });

  test('no verdict → callout falls back to the run error, else null', async () => {
    const { projectNaniteJournalDetail } = await import(
      '../src/webview/documentEditorProvider'
    );
    const failed = projectNaniteJournalDetail(
      journal({ outcome: 'failed', error: 'boom' }),
      nanite(),
      template(),
    );
    expect(failed.callout).toEqual({ variant: 'failed', verdict: '', score: '', reason: 'boom' });

    const clean = projectNaniteJournalDetail(journal(), nanite(), template());
    expect(clean.callout).toBeNull();
  });

  test('labels assistant vs tool steps with ok/failed flags', async () => {
    const { projectNaniteJournalDetail } = await import(
      '../src/webview/documentEditorProvider'
    );
    const j = journal();
    j.execution.steps = [
      { kind: 'assistant', text: 'Thinking…' },
      { kind: 'tool', name: 'run_command', ok: true, input: '{"cmd":"ls"}', result: 'ok' },
      { kind: 'tool', name: 'write_file', ok: false, error: 'permission denied' },
    ];
    const vm = projectNaniteJournalDetail(j, nanite(), template());
    expect(vm.steps).toEqual([
      { kind: 'assistant', label: 'Assistant', ok: null, text: 'Thinking…', input: '', result: '', error: '', friendly: null },
      { kind: 'tool', label: 'run_command', ok: true, text: '', input: '{"cmd":"ls"}', result: 'ok', error: '', friendly: null },
      { kind: 'tool', label: 'write_file', ok: false, text: '', input: '', result: '', error: 'permission denied', friendly: null },
    ]);
  });

  test('builds link-outs to the owning nanite and its template', async () => {
    const { projectNaniteJournalDetail } = await import(
      '../src/webview/documentEditorProvider'
    );
    const vm = projectNaniteJournalDetail(journal(), nanite({ request: 'Ship it' }), template({ id: 'tpl-9', title: 'Shipper' }));
    expect(vm.nanite).toEqual({ id: 'nan-1', title: 'Ship it' });
    expect(vm.template).toEqual({ id: 'tpl-9', title: 'Shipper' });
  });

  test('falls back to a short nanite id and empty template when unresolved', async () => {
    const { projectNaniteJournalDetail } = await import(
      '../src/webview/documentEditorProvider'
    );
    const j = journal();
    j.naniteId = 'abcdef0123456789';
    const vm = projectNaniteJournalDetail(j, null, null);
    expect(vm.nanite).toEqual({ id: 'abcdef0123456789', title: 'Nanite abcdef01' });
    expect(vm.template).toEqual({ id: '', title: '' });
  });
});

describe('groupStepsIntoRounds', () => {
  test('groups round-tagged steps into ordered rounds with narration + nested tools', async () => {
    const { groupStepsIntoRounds } = await import(
      '../src/webview/documentEditorProvider'
    );
    const rounds = groupStepsIntoRounds([
      { kind: 'assistant', round: 1, text: 'Looking things up.' },
      { kind: 'tool', round: 1, name: 'wm_list_topics', ok: true, input: '{}', result: 'ok' },
      { kind: 'assistant', round: 2, text: 'Now acting.' },
      { kind: 'tool', round: 2, name: 'wm_create_alert', ok: true, input: '{}', result: 'ok' },
      { kind: 'tool', round: 2, name: 'wm_close_topic', ok: false, error: 'nope' },
    ]);
    // Two round trips; the badge count is rounds.length.
    expect(rounds.length).toBe(2);
    expect(rounds[0].round).toBe(1);
    expect(rounds[0].narration).toBe('Looking things up.');
    expect(rounds[0].toolSteps.map((s) => s.label)).toEqual(['wm_list_topics']);
    expect(rounds[1].round).toBe(2);
    expect(rounds[1].narration).toBe('Now acting.');
    expect(rounds[1].toolSteps.map((s) => s.label)).toEqual(['wm_create_alert', 'wm_close_topic']);
    expect(rounds[1].toolSteps[1].ok).toBe(false);
    expect(rounds[1].toolSteps[1].error).toBe('nope');
    // Narration is round-level; nested tool steps carry no assistant text.
    expect(rounds[0].toolSteps.every((s) => s.text === '')).toBe(true);
  });

  test('back-compat: infers rounds from narration boundaries when round is absent', async () => {
    const { groupStepsIntoRounds } = await import(
      '../src/webview/documentEditorProvider'
    );
    const rounds = groupStepsIntoRounds([
      // Leading tool with no prior narration → forms the first round.
      { kind: 'tool', name: 'wm_list_topics', ok: true, input: '{}', result: 'ok' },
      { kind: 'assistant', text: 'Thinking.' },
      { kind: 'tool', name: 'wm_create_alert', ok: true, input: '{}', result: 'ok' },
      { kind: 'assistant', text: 'More thinking.' },
      { kind: 'tool', name: 'wm_close_topic', ok: true, input: '{}', result: 'ok' },
    ]);
    expect(rounds.length).toBe(3);
    expect(rounds[0].narration).toBe('');
    expect(rounds[0].toolSteps.map((s) => s.label)).toEqual(['wm_list_topics']);
    expect(rounds[1].narration).toBe('Thinking.');
    expect(rounds[1].toolSteps.map((s) => s.label)).toEqual(['wm_create_alert']);
    expect(rounds[2].narration).toBe('More thinking.');
    expect(rounds[2].toolSteps.map((s) => s.label)).toEqual(['wm_close_topic']);
  });

  test('a single-round run yields exactly one round', async () => {
    const { groupStepsIntoRounds } = await import(
      '../src/webview/documentEditorProvider'
    );
    const rounds = groupStepsIntoRounds([
      { kind: 'assistant', round: 1, text: 'One and done.' },
      { kind: 'tool', round: 1, name: 'wm_list_topics', ok: true, input: '{}', result: 'ok' },
    ]);
    expect(rounds.length).toBe(1);
    expect(rounds[0].narration).toBe('One and done.');
    expect(rounds[0].toolSteps.map((s) => s.label)).toEqual(['wm_list_topics']);
  });

  test('empty trace → no rounds', async () => {
    const { groupStepsIntoRounds } = await import(
      '../src/webview/documentEditorProvider'
    );
    expect(groupStepsIntoRounds([])).toEqual([]);
  });
});

describe('friendlyReadStep', () => {
  test('a topic-read step → friendly VM (label truncation + version + route)', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    const longTitle =
      'Add a category for each transaction so the ledger can be grouped and reported per spending area';
    const step = {
      kind: 'tool',
      name: 'ws-topic-read',
      result: JSON.stringify({
        count: 1,
        topics: [{ id: 't-1', slug: 'add-a-category', title: longTitle, resourceVersion: 123 }],
      }),
    };
    const vm = friendlyReadStep(step);
    expect(vm).not.toBeNull();
    expect(vm!.verb).toBe('read');
    expect(vm!.tool).toBe('ws-topic-read');
    expect(vm!.version).toBe(123);
    expect(vm!.route).toBe('/topic/add-a-category.working-memory');
    // Label is truncated to a single readable line ending in an ellipsis.
    expect(vm!.label.length).toBeLessThan(longTitle.length);
    expect(vm!.label.endsWith('…')).toBe(true);
  });

  test('a workstream-read step → friendly VM with a workstream route', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    const step = {
      kind: 'tool',
      name: 'ws-workstream-read',
      result: JSON.stringify({
        count: 1,
        workstreams: [{ id: 'w-1', slug: 'product-roadmap', title: 'Product Roadmap', resourceVersion: 7 }],
      }),
    };
    const vm = friendlyReadStep(step);
    expect(vm).toEqual({
      verb: 'read',
      tool: 'ws-workstream-read',
      mode: 'single',
      label: 'Product Roadmap',
      version: 7,
      route: '/workstream/product-roadmap.working-memory',
      scope: '',
      items: [],
      moreCount: 0,
    });
  });

  test('a non-slug WM read (e.g. alert) opens by document id', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    const step = {
      kind: 'tool',
      name: 'ws-alert-read',
      result: JSON.stringify({
        count: 1,
        alerts: [{ id: 'a-9', slug: null, title: 'Disk almost full', resourceVersion: 2 }],
      }),
    };
    const vm = friendlyReadStep(step);
    expect(vm).toEqual({
      verb: 'read',
      tool: 'ws-alert-read',
      mode: 'single',
      label: 'Disk almost full',
      version: 2,
      route: '/document/a-9.working-memory',
      scope: '',
      items: [],
      moreCount: 0,
    });
  });

  test('a multi-item topic-read → list VM with input-derived scope + one link per item', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    const step = {
      kind: 'tool',
      name: 'ws-topic-read',
      input: JSON.stringify({ workstream: 'banking-app' }),
      result: JSON.stringify({
        count: 3,
        topics: [
          { id: 't-1', slug: 'topic-a', title: 'Topic A', resourceVersion: 5 },
          { id: 't-2', slug: 'topic-b', name: 'Topic B', resourceVersion: 6 },
          { id: 't-3', slug: 'topic-c', resourceVersion: 7 },
        ],
      }),
    };
    const vm = friendlyReadStep(step);
    expect(vm).toEqual({
      verb: 'read',
      tool: 'ws-topic-read',
      mode: 'list',
      label: '',
      version: 0,
      route: '',
      scope: 'banking-app',
      items: [
        { label: 'Topic A', route: '/topic/topic-a.working-memory' },
        { label: 'Topic B', route: '/topic/topic-b.working-memory' },
        { label: 'topic-c', route: '/topic/topic-c.working-memory' },
      ],
      moreCount: 0,
    });
  });

  test('a huge list read is capped at 6 links with the overflow in moreCount', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    const topics = Array.from({ length: 10 }, (_, i) => ({
      id: `t-${i}`,
      slug: `topic-${i}`,
      title: `Topic ${i}`,
      resourceVersion: i,
    }));
    const vm = friendlyReadStep({
      kind: 'tool',
      name: 'ws-topic-read',
      input: JSON.stringify({ workstream: 'banking-app' }),
      result: JSON.stringify({ count: 10, topics }),
    });
    expect(vm!.mode).toBe('list');
    expect(vm!.items).toHaveLength(6);
    expect(vm!.moreCount).toBe(4);
    expect(vm!.scope).toBe('banking-app');
  });

  test('a list read with no workstream falls back to the query for scope', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    const vm = friendlyReadStep({
      kind: 'tool',
      name: 'ws-topic-read',
      input: JSON.stringify({ query: 'ledger' }),
      result: JSON.stringify({
        count: 2,
        topics: [
          { id: 't-1', slug: 'a', title: 'A', resourceVersion: 1 },
          { id: 't-2', slug: 'b', title: 'B', resourceVersion: 2 },
        ],
      }),
    });
    expect(vm!.mode).toBe('list');
    expect(vm!.scope).toBe('ledger');
    expect(vm!.items).toHaveLength(2);
  });

  test('a list read with unparseable input still renders (scope empty)', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    const vm = friendlyReadStep({
      kind: 'tool',
      name: 'ws-topic-read',
      input: 'not json {{',
      result: JSON.stringify({
        count: 2,
        topics: [
          { id: 't-1', slug: 'a', title: 'A', resourceVersion: 1 },
          { id: 't-2', slug: 'b', title: 'B', resourceVersion: 2 },
        ],
      }),
    });
    expect(vm!.mode).toBe('list');
    expect(vm!.scope).toBe('');
    expect(vm!.items).toHaveLength(2);
  });

  test('a non-WM tool step → null', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    expect(
      friendlyReadStep({ kind: 'tool', name: 'run_command', result: '{"count":1,"topics":[]}' }),
    ).toBeNull();
  });

  test('an assistant step → null', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    expect(friendlyReadStep({ kind: 'assistant', result: 'thinking' })).toBeNull();
  });

  test('a malformed-result step → null', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    expect(friendlyReadStep({ kind: 'tool', name: 'ws-topic-read', result: 'not json {{' })).toBeNull();
  });

  test('an empty result set → null', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    expect(
      friendlyReadStep({ kind: 'tool', name: 'ws-topic-read', result: '{"count":0,"topics":[]}' }),
    ).toBeNull();
  });

  test('PREFERS resultDigest over a truncated result (multi-item list)', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    // The raw result is TRUNCATED invalid JSON — parsing it would throw. The
    // digest must drive the rendering instead.
    const vm = friendlyReadStep({
      kind: 'tool',
      name: 'ws-topic-read',
      input: JSON.stringify({ workstream: 'banking-app' }),
      result: '{"count":2,"topics":[{"id":"t-1","slug":"topic-a","body":"lorem ipsum … (truncated)',
      resultDigest: {
        count: 2,
        items: [
          { id: 't-1', slug: 'topic-a', title: 'Topic A', resourceVersion: 5 },
          { id: 't-2', slug: 'topic-b', name: 'Topic B', resourceVersion: 6 },
        ],
      },
    });
    expect(vm).toEqual({
      verb: 'read',
      tool: 'ws-topic-read',
      mode: 'list',
      label: '',
      version: 0,
      route: '',
      scope: 'banking-app',
      items: [
        { label: 'Topic A', route: '/topic/topic-a.working-memory' },
        { label: 'Topic B', route: '/topic/topic-b.working-memory' },
      ],
      moreCount: 0,
    });
  });

  test('a single-item digest → versioned single form', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    const vm = friendlyReadStep({
      kind: 'tool',
      name: 'ws-topic-read',
      result: 'irrelevant truncated garbage {{',
      resultDigest: {
        count: 1,
        items: [{ id: 't-1', slug: 'add-a-category', title: 'Add a category', resourceVersion: 123 }],
      },
    });
    expect(vm).toEqual({
      verb: 'read',
      tool: 'ws-topic-read',
      mode: 'single',
      label: 'Add a category',
      version: 123,
      route: '/topic/add-a-category.working-memory',
      scope: '',
      items: [],
      moreCount: 0,
    });
  });

  test('a digest whose count exceeds the stored + display cap → moreCount from count', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    // Runner stores at most 12 items; view shows at most 6. count is the truth.
    const items = Array.from({ length: 12 }, (_, i) => ({
      id: `t-${i}`,
      slug: `topic-${i}`,
      title: `Topic ${i}`,
      resourceVersion: i,
    }));
    const vm = friendlyReadStep({
      kind: 'tool',
      name: 'ws-topic-read',
      input: JSON.stringify({ workstream: 'banking-app' }),
      result: '{"count":50, … truncated',
      resultDigest: { count: 50, items },
    });
    expect(vm!.mode).toBe('list');
    expect(vm!.items).toHaveLength(6);
    expect(vm!.moreCount).toBe(44);
  });

  test('FALLS BACK to result parsing when no digest is present (older journals)', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    const vm = friendlyReadStep({
      kind: 'tool',
      name: 'ws-topic-read',
      result: JSON.stringify({
        count: 1,
        topics: [{ id: 't-1', slug: 'legacy', title: 'Legacy', resourceVersion: 9 }],
      }),
    });
    expect(vm).toEqual({
      verb: 'read',
      tool: 'ws-topic-read',
      mode: 'single',
      label: 'Legacy',
      version: 9,
      route: '/topic/legacy.working-memory',
      scope: '',
      items: [],
      moreCount: 0,
    });
  });

  test('a non-WM tool step with a digest → still null', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    expect(
      friendlyReadStep({
        kind: 'tool',
        name: 'run_command',
        resultDigest: { count: 1, items: [{ id: 'x', slug: 'x', title: 'X', resourceVersion: 1 }] },
      }),
    ).toBeNull();
  });

  test('a digest with an empty items array falls through to the (absent) result → null', async () => {
    const { friendlyReadStep } = await import('../src/webview/documentEditorProvider');
    expect(
      friendlyReadStep({ kind: 'tool', name: 'ws-topic-read', resultDigest: { count: 0, items: [] } }),
    ).toBeNull();
  });
});


