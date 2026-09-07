/**
 * Pure shaping for rendering a finished nanite run in the ephemeral command
 * widget transcript. VS Code-free so app-link extraction and brief composition
 * remain unit-testable in isolation.
 */

import type { NaniteRunResult, NaniteRunStep } from './types';

/** How many characters of raw output to fall back to when there's no summary. */
const OUTPUT_HEAD_CHARS = 500;
/** Matches a per-container OrbStack host URL (`https://<name>.orb.local/...`). */
const ORB_URL_RE = /https:\/\/[a-z0-9._-]+\.orb\.local(?:\/[^\s)]*)?/i;


/**
 * Scan a run's execution trace for a host-reachable app URL exposed via the
 * per-run `expose_port` tool. The tool's text result is the bare OrbStack
 * domain (`https://<name>.orb.local/`), so we look at successful `expose_port`
 * tool steps first, then fall back to any `orb.local` URL anywhere in the trace
 * (robust to the exact step name). Returns the LAST match — the most recently
 * exposed port wins — or `undefined` when the run exposed nothing.
 */
export function extractExposedAppUrl(steps: NaniteRunStep[] | undefined): string | undefined {
  if (!steps || steps.length === 0) {
    return undefined;
  }
  let fallback: string | undefined;
  for (const step of steps) {
    if (step.kind !== 'tool') {
      continue;
    }
    const haystack = `${step.result ?? ''}`;
    const match = haystack.match(ORB_URL_RE)?.[0];
    if (!match) {
      continue;
    }
    if (step.name === 'expose_port' && step.ok !== false) {
      fallback = match; // a real expose_port result — prefer the latest.
    } else if (fallback === undefined) {
      fallback = match; // best-effort: any orb.local URL in the trace.
    }
  }
  return fallback;
}

/** Collapse whitespace and clip a string to `max` chars with an ellipsis. */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max).trimEnd()}…`;
}

/**
 * Compose the markdown brief posted into the chat: the outcome, a concise
 * summary of what the nanite did (the acceptance summary when present, else the
 * head of the raw output; the failure message on a failed run), and — when the
 * run exposed an app — a prominent clickable "Open the app" link.
 */
export function buildNaniteCompletionBrief(result: NaniteRunResult): string {
  const succeeded = result.status === 'succeeded';
  const lines: string[] = [];
  lines.push(succeeded ? '**Nanite succeeded.**' : '**Nanite failed.**');

  const summary = (result.acceptance?.summary ?? '').trim() || clip(result.output ?? '', OUTPUT_HEAD_CHARS);
  if (summary) {
    lines.push('', summary);
  }

  if (!succeeded) {
    const error = (result.error ?? '').trim();
    if (error) {
      lines.push('', `**Error:** ${error}`);
    }
  }

  const url = extractExposedAppUrl(result.steps);
  if (url) {
    lines.push('', `**Open the app:** [${url}](${url})`);
  }

  return lines.join('\n');
}
