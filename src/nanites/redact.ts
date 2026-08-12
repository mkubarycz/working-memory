/**
 * Pure secret-redaction for nanite run records (`nanite-container-credentials`).
 *
 * A nanite's dev container is handed a GitHub token via `--remote-env` so it can
 * clone/push. That token must NEVER surface in the durable run record — not in
 * the persisted `prompt` / `output` / `steps`, nor in the completion brief. This
 * module is `vscode`-free and side-effect-free so the scrubbing is unit-testable
 * in isolation and can run inside the pure runner core.
 *
 * It scrubs three forms:
 *  1. The exact known token value (when the caller knows it).
 *  2. `GH_TOKEN=…` / `GITHUB_TOKEN=…` env assignments (e.g. a leaked arg list).
 *  3. `x-access-token:…@github.com` credential-in-URL form (git remotes).
 */

import type { NaniteRunResult, NaniteRunStep } from './types';
/** The placeholder every redacted secret collapses to. */
const MASK = '***';

/**
 * Minimum length for masking a config VALUE by its bare literal. Short values
 * (e.g. `"1"`, `"on"`) are too collision-prone to blanket-replace across the
 * whole run text, so bare-literal masking is skipped below this length — the
 * `KEY=VALUE` assignment pattern (applied for every config key regardless of
 * length) still scrubs the common arg-list / env-leak form.
 */
const MIN_LITERAL_MASK_LEN = 4;

/**
 * The secrets a redaction pass knows about. Accepts a bare token string (the
 * legacy form) OR a descriptor carrying the GitHub `token` plus the full merged
 * `config` env map (keys stay visible, every value is scrubbed).
 */
export type RedactionSecrets =
  | string
  | null
  | undefined
  | {
      /** The GitHub token injected as GH_TOKEN/GITHUB_TOKEN. */
      token?: string | null;
      /** Merged configmap env: every VALUE is masked; keys stay visible. */
      config?: Record<string, string>;
    };

/** Escape a string for literal use inside a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalize the accepted secrets forms into a token + config map. */
function normalizeSecrets(secrets: RedactionSecrets): {
  token: string;
  config: Record<string, string>;
} {
  if (typeof secrets === 'string' || secrets == null) {
    return { token: (secrets ?? '').trim(), config: {} };
  }
  return { token: (secrets.token ?? '').trim(), config: secrets.config ?? {} };
}

/**
 * Scrub every known secret form from `text`. Safe to call on any string,
 * including `undefined`-ish inputs (returns them unchanged). Masks, in order:
 *  1. the exact GitHub token literal (when known);
 *  2. every injected config VALUE by bare literal (length ≥ 4, longest first so
 *     overlapping values collapse cleanly);
 *  3. `GH_TOKEN=…` / `GITHUB_TOKEN=…` and each config `KEY=…` assignment (keys
 *     stay visible, values masked) — catches arg-list / env leaks for any value
 *     length;
 *  4. the `x-access-token:…@github.com` credential-in-URL form.
 */
export function redactSecrets(text: string, secrets?: RedactionSecrets): string {
  if (!text) {
    return text;
  }
  const { token, config } = normalizeSecrets(secrets);
  let out = text;
  if (token.length > 0) {
    out = out.replace(new RegExp(escapeRegExp(token), 'g'), MASK);
  }
  // Mask every config value by its bare literal (longest first). Skips very
  // short values — those are still covered by the KEY= assignment pass below.
  const values = Object.values(config)
    .filter((v) => typeof v === 'string' && v.length >= MIN_LITERAL_MASK_LEN)
    .sort((a, b) => b.length - a.length);
  for (const value of values) {
    out = out.replace(new RegExp(escapeRegExp(value), 'g'), MASK);
  }
  out = out.replace(/GH_TOKEN=\S+/g, `GH_TOKEN=${MASK}`);
  out = out.replace(/GITHUB_TOKEN=\S+/g, `GITHUB_TOKEN=${MASK}`);
  // Every config KEY=<value> assignment (keys visible, value masked) so an
  // arbitrary config secret can't leak through an echoed arg list or env dump.
  for (const key of Object.keys(config)) {
    out = out.replace(new RegExp(`${escapeRegExp(key)}=\\S+`, 'g'), `${key}=${MASK}`);
  }
  out = out.replace(/x-access-token:[^@\s]+@github\.com/gi, `x-access-token:${MASK}@github.com`);
  return out;
}

/** Scrub secrets from a single run step's free-text fields. */
function redactStep(step: NaniteRunStep, secrets?: RedactionSecrets): NaniteRunStep {
  const next: NaniteRunStep = { ...step };
  if (next.text !== undefined) {
    next.text = redactSecrets(next.text, secrets);
  }
  if (next.input !== undefined) {
    next.input = redactSecrets(next.input, secrets);
  }
  if (next.result !== undefined) {
    next.result = redactSecrets(next.result, secrets);
  }
  if (next.error !== undefined) {
    next.error = redactSecrets(next.error, secrets);
  }
  return next;
}

/**
 * Return a copy of `result` with every persisted free-text field scrubbed:
 * `output`, `error`, each step's narration / arg / result / error preview, the
 * acceptance verdict's `summary`, and every tool-call trail `error`. Structural
 * fields (status, counts, tool-call names) are left untouched. The acceptance
 * summary + tool-call errors are echoes of run text that can carry a leaked
 * token / config value, so they must be scrubbed before landing in the journal
 * or the completion brief (redaction gap, `nanite-journal`).
 */
export function redactRunResult(
  result: NaniteRunResult,
  secrets?: RedactionSecrets,
): NaniteRunResult {
  return {
    ...result,
    output: redactSecrets(result.output, secrets),
    error: result.error === undefined ? undefined : redactSecrets(result.error, secrets),
    steps: result.steps.map((step) => redactStep(step, secrets)),
    acceptance:
      result.acceptance === undefined
        ? undefined
        : { ...result.acceptance, summary: redactSecrets(result.acceptance.summary, secrets) },
    toolCalls: result.toolCalls.map((call) =>
      call.error === undefined ? call : { ...call, error: redactSecrets(call.error, secrets) },
    ),
  };
}
