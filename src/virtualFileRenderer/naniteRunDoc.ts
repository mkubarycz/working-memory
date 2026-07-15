import { JournalStore } from '../db';
import { NanitesStore } from '../nanites/store';
import type { NaniteRun } from '../nanites/types';
import { deepLink, fmtDateTime, fmtDuration, fmtRelative } from './shared';

const RUN_STATUS_ICON: Record<NaniteRun['status'], string> = {
  pending: 'circle-outline',
  running: 'sync',
  succeeded: 'pass',
  failed: 'error',
};

/** Pretty-print a parsed JSON result inside a fenced block, or a placeholder. */
function renderResult(result: unknown): string {
  if (result === null || result === undefined) {
    return '_No result recorded._';
  }
  let json: string;
  try {
    json = JSON.stringify(result, null, 2);
  } catch {
    json = String(result);
  }
  return ['```json', json, '```'].join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The confidence-score line for the Execution section:
 * `Confidence Score: PASS 88%`, colored by band — green ≥ 88 (PASS),
 * yellow ≥ 70 (UNCERTAIN), red < 70 (FAILING).
 */
function renderConfidenceScore(result: unknown): string | null {
  const r = asRecord(result);
  const acc = r ? asRecord(r.acceptance) : null;
  if (!acc || typeof acc.confidence !== 'number') {
    return null;
  }
  const pct = Math.round(acc.confidence);
  let label: string;
  let color: string;
  if (pct >= 88) {
    label = 'PASS';
    color = '#3fb950';
  } else if (pct >= 70) {
    label = 'UNCERTAIN';
    color = '#d29922';
  } else {
    label = 'FAILING';
    color = '#f85149';
  }
  return `- **Confidence Score:** <span style="color:${color};font-weight:600">${label} ${pct}%</span>`;
}

/** Model id + approximate total token usage pulled off the run result JSON. */
function renderExecution(result: unknown): string {
  const r = asRecord(result);
  if (!r) {
    return '_No execution data recorded._';
  }
  const lines: string[] = [];
  const confidence = renderConfidenceScore(result);
  if (confidence) {
    lines.push(confidence);
  }
  if (typeof r.model === 'string' && r.model) {
    lines.push(`- **Model:** \`${r.model}\``);
  }
  const hasTokens =
    typeof r.total_tokens === 'number' ||
    typeof r.input_tokens === 'number' ||
    typeof r.output_tokens === 'number';
  if (hasTokens) {
    const totTok =
      typeof r.total_tokens === 'number'
        ? r.total_tokens
        : (typeof r.input_tokens === 'number' ? r.input_tokens : 0) +
          (typeof r.output_tokens === 'number' ? r.output_tokens : 0);
    lines.push(`- **Tokens:** ~${totTok} (approx)`);
  }
  return lines.length ? lines.join('\n') : '_No execution data recorded._';
}

/**
 * A restatement of what the run was asked to do, plus the verbatim prompt the
 * nanite executed with. The restatement comes from `request.summary`; the raw
 * prompt from `request.prompt`, falling back to the legacy top-level `prompt`
 * on older runs that predate nesting.
 */
function renderRequestSection(result: unknown): string {
  const r = asRecord(result);
  const req = r ? asRecord(r.request) : null;
  const summary =
    req && typeof req.summary === 'string' && req.summary.trim()
      ? req.summary.trim()
      : '_(no request recorded)_';
  const rawPrompt =
    req && typeof req.prompt === 'string' && req.prompt.trim()
      ? req.prompt.trim()
      : r && typeof r.prompt === 'string' && r.prompt.trim()
        ? r.prompt.trim()
        : '';
  if (!rawPrompt) {
    return summary;
  }
  const promptBlock = rawPrompt.includes('\n')
    ? ['**Prompt:**', '', '```', rawPrompt, '```'].join('\n')
    : `**Prompt:** \`${rawPrompt}\``;
  return [summary, '', promptBlock].join('\n');
}

/**
 * A summary of what the run produced. Older runs won't have a structured
 * `response` — fall back to the top-level raw text blob (named `output`,
 * legacy runs used `summary`), then to a placeholder.
 */
function renderResponseSection(result: unknown): string {
  const r = asRecord(result);
  const res = r ? asRecord(r.response) : null;
  const rawText = r ? ((res?.output ?? r.output ?? r.summary) as unknown) : undefined;
  const legacySummary = typeof rawText === 'string' ? rawText.trim() : '';
  if (res && typeof res.summary === 'string' && res.summary.trim()) {
    return res.summary.trim();
  }
  return legacySummary || '_(no response recorded)_';
}

/** The acceptance verdict: pass/fail icon, rationale, and the score line. */
function renderAcceptanceSection(result: unknown): string {
  const r = asRecord(result);
  const acc = r ? asRecord(r.acceptance) : null;
  if (!acc) {
    return '_No acceptance verdict recorded._';
  }
  const passed = acc.passed === true;
  const icon = passed ? 'pass' : 'error';
  const summary =
    typeof acc.summary === 'string' && acc.summary.trim()
      ? acc.summary.trim()
      : '_(no rationale given)_';
  return `<span class="codicon codicon-${icon}" style="vertical-align:text-bottom"></span> ${summary}`;
}

/** The nanite's verbatim final output text (legacy runs stored it as `summary`). */
function renderOutputSection(result: unknown): string {
  const r = asRecord(result);
  const resp = r ? asRecord(r.response) : null;
  const raw = r ? ((resp?.output ?? r.output ?? r.summary) as unknown) : undefined;
  const text = typeof raw === 'string' ? raw.trim() : '';
  return text || '_No output recorded._';
}

/**
 * Render the read-only virtual doc for a single nanite run
 * (`working-memory:/nanite-run/<id>.md`). Shows status, timings, the parent
 * nanite (as a deep link), the structured result JSON, and any error. Linked
 * from the parent nanite doc's "Recent runs" list so Michael can drill into
 * the last 10 runs without leaving the editor.
 */
export function renderNaniteRunDoc(store: JournalStore, idStr: string): string {
  const id = Number(idStr);
  if (!Number.isInteger(id) || id <= 0) {
    return `# Nanite run not found\n\n\`${idStr}\` is not a valid run id.\n`;
  }
  const nanites = new NanitesStore(store.connection);
  const run = nanites.getRun(id);
  if (!run) {
    return `# Nanite run not found\n\nNo run with id \`${id}\`.\n`;
  }
  const nanite = nanites.getNaniteById(run.nanite_id, true);
  const icon = RUN_STATUS_ICON[run.status] ?? 'circle-outline';
  const when = run.started_at ?? run.created_at;
  const duration = fmtDuration(run.started_at, run.ended_at);
  const naniteLine = nanite
    ? `[${nanite.title}](${deepLink('nanite', nanite.slug)})`
    : `_(nanite #${run.nanite_id} not found)_`;

  return [
    `# Run #${run.id} — ${nanite ? nanite.title : `nanite #${run.nanite_id}`}`,
    '',
    `- **Status:** <span class="codicon codicon-${icon}" style="vertical-align:text-bottom"></span> ${run.status}`,
    `- **Nanite:** ${naniteLine}`,
    `- **Created:** ${fmtDateTime(run.created_at)} (${fmtRelative(run.created_at)})`,
    `- **Started:** ${run.started_at ? fmtDateTime(run.started_at) : '_not started_'}`,
    `- **Ended:** ${run.ended_at ? fmtDateTime(run.ended_at) : '_still running / not finished_'}`,
    duration ? `- **Duration:** ${duration}` : null,
    '',
    '_This run doc is read-only — it renders fresh from the DB on every open._',
    '',
    '## Execution',
    '',
    renderExecution(run.result),
    '',
    '## Request',
    '',
    renderRequestSection(run.result),
    '',
    '## Response',
    '',
    renderResponseSection(run.result),
    '',
    '## Acceptance',
    '',
    renderAcceptanceSection(run.result),
    '',
    '## Error',
    '',
    run.error ? ['```', run.error, '```'].join('\n') : '_No error._',
    '',
    '## Output',
    '',
    renderOutputSection(run.result),
    '',
    '## Raw result',
    '',
    renderResult(run.result),
    '',
    `_Back to nanite: ${naniteLine}._`,
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
