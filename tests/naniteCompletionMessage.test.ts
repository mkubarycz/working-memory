import { describe, expect, test } from 'vitest';
import {
  buildNaniteCompletionBrief,
  buildNaniteCompletionSpec,
  buildNaniteCompletionSpecs,
  extractExposedAppUrl,
  naniteCompletionScope,
  naniteSessionScope,
  type NaniteCompletionSource,
} from '../src/nanites/completionMessage';
import type { NaniteRunResult, NaniteRunStep } from '../src/nanites/types';

/** A minimal succeeded run result; override fields per test. */
function result(overrides: Partial<NaniteRunResult> = {}): NaniteRunResult {
  return {
    status: 'succeeded',
    output: '',
    toolCalls: [],
    steps: [],
    iterations: 1,
    hitIterationCap: false,
    ...overrides,
  };
}

const NANITE: NaniteCompletionSource = {
  inputTopic: 'ship-the-thing',
  workstream: 'product',
  request: 'Build the landing page',
};

describe('naniteCompletionScope', () => {
  test('prefers the input topic', () => {
    expect(naniteCompletionScope(NANITE)).toEqual({ scopeKey: 'ship-the-thing', kind: 'topic' });
  });

  test('falls back to the workstream when there is no input topic', () => {
    expect(naniteCompletionScope({ ...NANITE, inputTopic: '  ' })).toEqual({
      scopeKey: 'product',
      kind: 'workstream',
    });
  });

  test('returns null when neither scope is set', () => {
    expect(naniteCompletionScope({ inputTopic: '', workstream: '', request: 'x' })).toBeNull();
  });
});

describe('naniteSessionScope', () => {
  test('scopes to the nanite id with contextKind nanite', () => {
    expect(naniteSessionScope({ ...NANITE, id: 'nanite-42' })).toEqual({
      scopeKey: 'nanite-42',
      kind: 'nanite',
    });
  });

  test('returns null when the source carries no id', () => {
    expect(naniteSessionScope(NANITE)).toBeNull();
    expect(naniteSessionScope({ ...NANITE, id: '  ' })).toBeNull();
  });
});

describe('buildNaniteCompletionSpecs', () => {
  test('posts the nanite session FIRST, then the input-topic ticket', () => {
    const specs = buildNaniteCompletionSpecs({
      nanite: { ...NANITE, id: 'nanite-42' },
      result: result({ output: 'ok' }),
    });
    expect(specs.map((s) => [s.workstream, s.request.contextKind])).toEqual([
      ['nanite-42', 'nanite'],
      ['ship-the-thing', 'topic'],
    ]);
  });

  test('falls back to the workstream ticket when there is no input topic', () => {
    const specs = buildNaniteCompletionSpecs({
      nanite: { id: 'nanite-42', inputTopic: '', workstream: 'product', request: 'x' },
      result: result(),
    });
    expect(specs.map((s) => [s.workstream, s.request.contextKind])).toEqual([
      ['nanite-42', 'nanite'],
      ['product', 'workstream'],
    ]);
  });

  test('emits only the session post when the nanite has no ticket scope', () => {
    const specs = buildNaniteCompletionSpecs({
      nanite: { id: 'nanite-42', inputTopic: '', workstream: '', request: 'x' },
      result: result(),
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].request.contextKind).toBe('nanite');
  });

  test('dedupes when the id equals the ticket scope key', () => {
    const specs = buildNaniteCompletionSpecs({
      nanite: { id: 'ship-the-thing', inputTopic: 'ship-the-thing', workstream: 'product', request: 'x' },
      result: result(),
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].workstream).toBe('ship-the-thing');
  });

  test('emits nothing when the nanite has neither an id nor a ticket scope', () => {
    const specs = buildNaniteCompletionSpecs({
      nanite: { inputTopic: '', workstream: '', request: 'x' },
      result: result(),
    });
    expect(specs).toHaveLength(0);
  });
});

describe('extractExposedAppUrl', () => {
  const exposeStep = (result: string, ok = true): NaniteRunStep => ({
    kind: 'tool',
    name: 'expose_port',
    ok,
    result,
  });

  test('pulls the orb.local URL from an expose_port step', () => {
    const steps: NaniteRunStep[] = [
      { kind: 'assistant', text: 'starting the server' },
      exposeStep('https://wm-nanite-run-9.orb.local/'),
    ];
    expect(extractExposedAppUrl(steps)).toBe('https://wm-nanite-run-9.orb.local/');
  });

  test('returns undefined when nothing was exposed', () => {
    const steps: NaniteRunStep[] = [
      { kind: 'assistant', text: 'done' },
      { kind: 'tool', name: 'run_command', ok: true, result: 'built ok' },
    ];
    expect(extractExposedAppUrl(steps)).toBeUndefined();
  });

  test('ignores a failed expose_port step but takes the last successful URL', () => {
    const steps: NaniteRunStep[] = [
      exposeStep('boom', false),
      exposeStep('https://first.orb.local/'),
      exposeStep('https://second.orb.local/'),
    ];
    expect(extractExposedAppUrl(steps)).toBe('https://second.orb.local/');
  });

  test('handles empty / missing steps', () => {
    expect(extractExposedAppUrl(undefined)).toBeUndefined();
    expect(extractExposedAppUrl([])).toBeUndefined();
  });
});

describe('buildNaniteCompletionBrief', () => {
  test('succeeded with an exposed app surfaces the clickable link', () => {
    const brief = buildNaniteCompletionBrief(
      result({
        acceptance: { summary: 'Landing page built and served.', confidence: 90, threshold: 60, passed: true },
        steps: [{ kind: 'tool', name: 'expose_port', ok: true, result: 'https://app.orb.local/' }],
      }),
    );
    expect(brief).toContain('**Nanite succeeded.**');
    expect(brief).toContain('Landing page built and served.');
    expect(brief).toContain('**Open the app:** [https://app.orb.local/](https://app.orb.local/)');
  });

  test('succeeded without a link falls back to the output head and omits the app line', () => {
    const brief = buildNaniteCompletionBrief(
      result({ output: 'Refactored the parser and added tests.' }),
    );
    expect(brief).toContain('**Nanite succeeded.**');
    expect(brief).toContain('Refactored the parser and added tests.');
    expect(brief).not.toContain('Open the app');
  });

  test('failed includes the error message', () => {
    const brief = buildNaniteCompletionBrief(
      result({ status: 'failed', error: 'model call timed out after 120s' }),
    );
    expect(brief).toContain('**Nanite failed.**');
    expect(brief).toContain('**Error:** model call timed out after 120s');
  });
});

describe('buildNaniteCompletionSpec', () => {
  test('scopes to the input topic and maps status + command label', () => {
    const spec = buildNaniteCompletionSpec({
      nanite: NANITE,
      result: result({ output: 'ok' }),
      templateLabel: 'Landing Builder',
      now: 123,
    });
    expect(spec).not.toBeNull();
    expect(spec!.workstream).toBe('ship-the-thing');
    expect(spec!.status).toBe('succeeded');
    expect(spec!.request.contextSlug).toBe('ship-the-thing');
    expect(spec!.request.contextKind).toBe('topic');
    expect(spec!.request.command).toBe('[nanite] Build the landing page');
    expect(spec!.request.ts).toBe(123);
  });

  test('scopes to the workstream and uses the template label when there is no request', () => {
    const spec = buildNaniteCompletionSpec({
      nanite: { inputTopic: '', workstream: 'product', request: '' },
      result: result({ status: 'failed', error: 'nope' }),
      templateLabel: 'Landing Builder',
    });
    expect(spec!.workstream).toBe('product');
    expect(spec!.request.contextKind).toBe('workstream');
    expect(spec!.status).toBe('failed');
    expect(spec!.request.command).toBe('[nanite] Landing Builder');
  });

  test('returns null when the nanite has no scope', () => {
    const spec = buildNaniteCompletionSpec({
      nanite: { inputTopic: '', workstream: '', request: 'x' },
      result: result(),
    });
    expect(spec).toBeNull();
  });
});
