/**
 * Pure shaping for the "nanite finished → post to the Working Memory chat"
 * feature (`nanite-completion-message-to-chat`). VS Code-free and
 * control-plane-free so the scope selection, app-link extraction, and brief
 * composition are unit-testable in isolation.
 *
 * The extension-host runner calls {@link buildNaniteCompletionSpec} right after
 * a terminal run persists, then hands the resulting {@link CommandJournalSpec}
 * to `ControlPlaneClient.commandJournalCreate` — so the completion turn renders
 * in the command widget exactly like any human-issued command turn, scoped to
 * the nanite's input topic (or its workstream) so it lands on that ticket.
 */

import { buildJournalSpec, type CommandJournalSpec } from '../commandJournal';
import type { NaniteRunResult, NaniteRunStep } from './types';

/** The subset of a Nanite the completion turn needs (kept structural for tests). */
export interface NaniteCompletionSource {
  /**
   * The nanite's own document id — the MANDATORY chat scope. A completed run's
   * turn is journaled under this key (`contextKind: 'nanite'`), the same channel
   * the command widget shows when the nanite doc is focused and the chat-directed
   * agent path posts to. Optional only so the legacy topic/workstream-scoped
   * helpers stay callable without an id.
   */
  id?: string;
  /** The nanite's input topic slug (empty ⇒ workstream-scoped run). */
  inputTopic: string;
  /** The owning workstream slug (the fallback scope). */
  workstream: string;
  /** The human request the nanite ran, if any (used for the command label). */
  request: string;
}

/** How many characters of raw output to fall back to when there's no summary. */
const OUTPUT_HEAD_CHARS = 500;
/** Matches a per-container OrbStack host URL (`https://<name>.orb.local/...`). */
const ORB_URL_RE = /https:\/\/[a-z0-9._-]+\.orb\.local(?:\/[^\s)]*)?/i;

/** The scope a completion turn is journaled under (mirrors the widget's scope). */
export interface NaniteCompletionScope {
  /** The scope key `commandJournalCreate` keys the turn by. */
  scopeKey: string;
  /** `'nanite'` for the nanite's own session, `'topic'`/`'workstream'` for the ticket. */
  kind: 'nanite' | 'topic' | 'workstream';
}

/**
 * The nanite's OWN chat session scope — keyed by its document id, mirroring the
 * command widget's `setContext({ kind: 'nanite', slug: <id> })`. This is the
 * MANDATORY channel a completed run must post to so its request + summary show
 * up in the nanite's session. Returns `null` only when the source carries no id.
 */
export function naniteSessionScope(
  nanite: NaniteCompletionSource,
): NaniteCompletionScope | null {
  const id = (nanite.id ?? '').trim();
  return id.length > 0 ? { scopeKey: id, kind: 'nanite' } : null;
}

/**
 * Choose the TICKET scope a completion turn also lands on: the nanite's input
 * topic when set, else its workstream. Returns `null` when BOTH are empty — the
 * caller skips this secondary post rather than journaling under a meaningless
 * key. (The nanite's own session — {@link naniteSessionScope} — is separate and
 * mandatory.)
 */
export function naniteCompletionScope(
  nanite: NaniteCompletionSource,
): NaniteCompletionScope | null {
  const topic = nanite.inputTopic.trim();
  if (topic.length > 0) {
    return { scopeKey: topic, kind: 'topic' };
  }
  const workstream = nanite.workstream.trim();
  if (workstream.length > 0) {
    return { scopeKey: workstream, kind: 'workstream' };
  }
  return null;
}

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

/** Inputs for {@link buildNaniteCompletionSpec}. */
export interface BuildNaniteCompletionSpecInput {
  nanite: NaniteCompletionSource;
  result: NaniteRunResult;
  /** The nanite's template slug/title, used in the command label when present. */
  templateLabel?: string | null;
  /** Injectable clock (defaults to `Date.now`) for deterministic tests. */
  now?: number;
}

/** Build the `[nanite] …` command label shown as the turn's request line. */
function buildCommandLabel(nanite: NaniteCompletionSource, templateLabel?: string | null): string {
  const request = nanite.request.trim();
  const label = request || (templateLabel ?? '').trim() || 'run';
  return `[nanite] ${clip(label, 120)}`;
}

/**
 * Shape a finished nanite run into a `CommandJournal` spec scoped to a single
 * {@link NaniteCompletionScope}. Reuses {@link buildJournalSpec} so the turn
 * renders identically to a human-issued command turn.
 */
function buildSpecForScope(
  input: BuildNaniteCompletionSpecInput,
  scope: NaniteCompletionScope,
): CommandJournalSpec {
  return buildJournalSpec({
    workstream: scope.scopeKey,
    command: buildCommandLabel(input.nanite, input.templateLabel),
    contextSlug: scope.scopeKey,
    contextKind: scope.kind,
    brief: buildNaniteCompletionBrief(input.result),
    toolCalls: [],
    corrections: [],
    stopReason: input.result.status,
    status: input.result.status,
    naniteJournalId: input.result.journalId,
    now: input.now,
  });
}

/**
 * Shape a finished nanite run into the `CommandJournal` turns it should post.
 * ALWAYS includes the nanite's OWN session (keyed by its id) so the run's
 * request + summary show up in the nanite's chat — the same channel the command
 * widget renders for a focused nanite and the agent-directive path writes to.
 * ADDITIONALLY includes the run's input-topic (or workstream) turn when present,
 * so the ticket carries the outcome too. A scope is emitted at most once (the
 * nanite id never collides with a topic/workstream slug in practice, but the
 * dedupe keeps it safe). Empty when the nanite has neither an id nor a ticket
 * scope.
 */
export function buildNaniteCompletionSpecs(
  input: BuildNaniteCompletionSpecInput,
): CommandJournalSpec[] {
  const specs: CommandJournalSpec[] = [];
  const seen = new Set<string>();
  const session = naniteSessionScope(input.nanite);
  if (session) {
    specs.push(buildSpecForScope(input, session));
    seen.add(session.scopeKey);
  }
  const ticket = naniteCompletionScope(input.nanite);
  if (ticket && !seen.has(ticket.scopeKey)) {
    specs.push(buildSpecForScope(input, ticket));
  }
  return specs;
}

/**
 * Shape a finished nanite run into a single `CommandJournal` spec scoped to the
 * nanite's input topic (or workstream), or `null` when the nanite has neither
 * scope. Kept for the ticket-only callers; the runner uses
 * {@link buildNaniteCompletionSpecs} to ALSO post to the nanite's own session.
 */
export function buildNaniteCompletionSpec(
  input: BuildNaniteCompletionSpecInput,
): CommandJournalSpec | null {
  const scope = naniteCompletionScope(input.nanite);
  if (!scope) {
    return null;
  }
  return buildSpecForScope(input, scope);
}
