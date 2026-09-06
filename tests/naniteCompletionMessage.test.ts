import { describe, expect, test } from 'vitest';
import {
  buildNaniteCompletionBrief,
  extractExposedAppUrl,
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
