import { describe, expect, test } from 'vitest';
import { redactSecrets, redactRunResult } from '../src/nanites/redact';
import type { NaniteRunResult } from '../src/nanites/types';

describe('redactSecrets', () => {
  const TOKEN = 'github_pat_11ABCDEF0123456789_secretvalue';

  test('masks the exact known token value wherever it appears', () => {
    const input = `cloned with ${TOKEN}; remote set to ${TOKEN}`;
    const out = redactSecrets(input, TOKEN);
    expect(out).not.toContain(TOKEN);
    expect(out).toBe('cloned with ***; remote set to ***');
  });

  test('masks GH_TOKEN= and GITHUB_TOKEN= env assignments without knowing the value', () => {
    const input = 'up --remote-env GH_TOKEN=ghp_abc123 --remote-env GITHUB_TOKEN=ghp_abc123';
    const out = redactSecrets(input);
    expect(out).toBe('up --remote-env GH_TOKEN=*** --remote-env GITHUB_TOKEN=***');
    expect(out).not.toContain('ghp_abc123');
  });

  test('masks an x-access-token:…@github.com credential-in-URL', () => {
    const input = 'https://x-access-token:ghp_deadbeef@github.com/mkubarycz/working-memory.git';
    const out = redactSecrets(input);
    expect(out).toBe('https://x-access-token:***@github.com/mkubarycz/working-memory.git');
    expect(out).not.toContain('ghp_deadbeef');
  });

  test('is a no-op on empty / clean text', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets('nothing secret here')).toBe('nothing secret here');
  });

  test('handles a null/undefined token by falling back to the patterns', () => {
    const input = 'GH_TOKEN=xyz set';
    expect(redactSecrets(input, null)).toBe('GH_TOKEN=*** set');
    expect(redactSecrets(input, undefined)).toBe('GH_TOKEN=*** set');
  });
});

describe('redactRunResult', () => {
  const TOKEN = 'ghp_supersecrettoken';

  function baseResult(): NaniteRunResult {
    return {
      status: 'succeeded',
      output: `pushed using ${TOKEN}`,
      toolCalls: [],
      steps: [
        { kind: 'assistant', text: `will use ${TOKEN}` },
        {
          kind: 'tool',
          name: 'run_command',
          ok: false,
          input: 'git remote add origin https://x-access-token:ghp_leak@github.com/o/r.git',
          result: 'GH_TOKEN=ghp_leak exported',
          error: `auth failed with ${TOKEN}`,
        },
      ],
      iterations: 1,
      hitIterationCap: false,
      error: `boom ${TOKEN}`,
    };
  }

  test('scrubs the token value + patterns from output, error, and every step field', () => {
    const out = redactRunResult(baseResult(), TOKEN);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('ghp_leak');
    expect(out.output).toBe('pushed using ***');
    expect(out.error).toBe('boom ***');
    expect(out.steps[0].text).toBe('will use ***');
    expect(out.steps[1].input).toContain('x-access-token:***@github.com');
    expect(out.steps[1].result).toBe('GH_TOKEN=*** exported');
    expect(out.steps[1].error).toBe('auth failed with ***');
  });

  test('leaves structural fields untouched', () => {
    const out = redactRunResult(baseResult(), TOKEN);
    expect(out.status).toBe('succeeded');
    expect(out.iterations).toBe(1);
    expect(out.steps[1].name).toBe('run_command');
    expect(out.steps[1].ok).toBe(false);
  });

  test('works with no token by relying on the patterns alone', () => {
    const out = redactRunResult(baseResult());
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('ghp_leak');
    // The exact token value is not known here, so it is NOT masked — only the
    // pattern-matched leaks are. This documents the fallback behaviour.
    expect(out.steps[1].result).toBe('GH_TOKEN=*** exported');
  });
});

describe('redactSecrets with injected config values', () => {
  const TOKEN = 'github_pat_11ABCDEF0123456789_secretvalue';

  test('masks EVERY injected config value (keys stay visible)', () => {
    const config = {
      DB_PASSWORD: 'sup3r-s3cret-db-pw',
      API_KEY: 'ak_live_9f8e7d6c5b4a',
    };
    const input =
      'connecting with DB_PASSWORD=sup3r-s3cret-db-pw; the key sup3r-s3cret-db-pw ' +
      'leaked, and API_KEY=ak_live_9f8e7d6c5b4a too';
    const out = redactSecrets(input, { config });
    expect(out).not.toContain('sup3r-s3cret-db-pw');
    expect(out).not.toContain('ak_live_9f8e7d6c5b4a');
    // Keys stay visible in the assignment form.
    expect(out).toContain('DB_PASSWORD=***');
    expect(out).toContain('API_KEY=***');
  });

  test('a config GH_TOKEN value is scrubbed just like the SecretStorage token', () => {
    const config = { GH_TOKEN: 'ghp_configvalue1234' };
    const input = 'up --remote-env GH_TOKEN=ghp_configvalue1234 && echo ghp_configvalue1234';
    const out = redactSecrets(input, { config });
    expect(out).not.toContain('ghp_configvalue1234');
    expect(out).toBe('up --remote-env GH_TOKEN=*** && echo ***');
  });

  test('masks token AND config values together', () => {
    const out = redactSecrets(`token=${TOKEN} value=cfg_secret_value`, {
      token: TOKEN,
      config: { MY_KEY: 'cfg_secret_value' },
    });
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain('cfg_secret_value');
  });

  test('skips bare-literal masking for very short values but still masks KEY=short', () => {
    const config = { MODE: 'on' };
    // The bare word "on" is left alone (too collision-prone), but the
    // MODE=on assignment form is still scrubbed.
    const out = redactSecrets('the button is on and MODE=on now', { config });
    expect(out).toBe('the button is on and MODE=*** now');
  });

  test('redactRunResult scrubs arbitrary config values across all fields', () => {
    const config = { DB_PASSWORD: 'p@ss-w0rd-longer' };
    const result: NaniteRunResult = {
      status: 'succeeded',
      output: 'wrote DB_PASSWORD=p@ss-w0rd-longer to .env',
      toolCalls: [],
      steps: [{ kind: 'assistant', text: 'used p@ss-w0rd-longer' }],
      iterations: 1,
      hitIterationCap: false,
      error: 'failed near p@ss-w0rd-longer',
    };
    const out = redactRunResult(result, { config });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('p@ss-w0rd-longer');
    expect(out.output).toBe('wrote DB_PASSWORD=*** to .env');
    expect(out.steps[0].text).toBe('used ***');
  });
});
