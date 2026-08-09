/**
 * Pure journal-shaping helpers for the CommandJournal POC
 * (`command-journal-document-kind`). VS Code-free and control-plane-free so the
 * shaping is unit-testable in isolation; the widget host and the
 * {@link ControlPlaneClient} consume these to persist + replay the command
 * widget's per-workstream chat.
 *
 * The `CommandJournal` kind stores ONE document per request/response cycle. This
 * module maps a finished tool-loop run into that kind's `spec`, and maps stored
 * journal envelopes back into (a) replay turns for the webview transcript and
 * (b) prior-turn chat history for the next model call (context carryover
 * baseline A — full replay).
 */

import type { DocumentEnvelope } from './controlPlaneClient';
import type { Correction, PriorTurn, ToolCallRecord, TokenUsage } from './wmToolLoop';

/** The control-plane kind name (mirrors `control-plane/.../commandjournal`). */
export const COMMAND_JOURNAL_KIND = 'CommandJournal';

/**
 * A journaled turn's lifecycle status (a `spec` field, mirroring the kind's zod
 * enum). Two-phase write: `running` the moment the request is journaled on
 * submit, then `succeeded`/`failed` when the run finishes and the record is
 * updated. A leftover `running` record is the safety win — a hard crash still
 * leaves a request-only trace instead of nothing.
 */
export type CommandJournalStatus = 'running' | 'succeeded' | 'failed';

/**
 * The scope key used when the widget has no selected document. Journaling under
 * a sentinel bucket keeps an unscoped chat replayable across reloads instead of
 * dropping it. (POC simplification — Michael's open question.)
 */
export const GLOBAL_SCOPE_KEY = '__global__';

/** The request half of a CommandJournal doc. */
export interface CommandJournalRequest {
  command: string;
  contextSlug?: string;
  contextKind?: string;
  /** Unix ms — the replay ordering key. */
  ts: number;
}

/** The response half of a CommandJournal doc. */
export interface CommandJournalResponse {
  /** The rendered markdown brief (replayed verbatim into the chat). */
  brief: string;
  toolCalls: ToolCallRecord[];
  corrections: Correction[];
  stopReason: string;
  tokens?: { promptTokens?: number; evalTokens?: number; calls?: number };
  /** Wall-clock timing for the run (benchmarking story). Optional/back-compat. */
  timings?: CommandJournalTimings;
}

/**
 * Wall-clock timing (ms) for one command run (benchmarking story
 * `performance-concerns-llm-calls`). All fields optional so old docs — and
 * partial measurements — still parse. `journalWriteMs` is measured AROUND the
 * create call, so it can't be inside the record it writes; the provider logs it
 * and omits it from the stored record (see `buildJournalSpec`).
 */
export interface CommandJournalTimings {
  /** End-to-end wall-clock (submit → brief ready). */
  totalMs?: number;
  /** Summed model-call time. */
  modelMs?: number;
  /** Number of model calls. */
  modelCalls?: number;
  /** Duration of the pre-run history load (`commandJournalReadByWorkstream`). */
  journalReadMs?: number;
  /** Duration of the post-run journal write (`commandJournalCreate`). */
  journalWriteMs?: number;
  /** Derived tools/overhead time (total − model − journalRead), floored at 0. */
  toolsMs?: number;
}

/** The full CommandJournal `spec` (workstream = the scope/tracking key). */
export interface CommandJournalSpec {
  workstream: string;
  /** The turn's lifecycle status (two-phase write). Defaults to `running`. */
  status: CommandJournalStatus;
  request: CommandJournalRequest;
  response: CommandJournalResponse;
}

/**
 * The scope key a turn is journaled under: the widget's context slug (topic OR
 * workstream — the POC keys a conversation by whatever is selected), or the
 * global sentinel when nothing is selected.
 */
export function scopeKeyFor(contextSlug: string | null | undefined): string {
  const slug = (contextSlug ?? '').trim();
  return slug.length > 0 ? slug : GLOBAL_SCOPE_KEY;
}

/** Inputs needed to shape one journal record from a finished run. */
export interface BuildJournalSpecInput {
  workstream: string;
  command: string;
  contextSlug: string | null;
  contextKind: string | null;
  brief: string;
  toolCalls: ToolCallRecord[];
  corrections: Correction[];
  stopReason: string;
  tokens?: TokenUsage;
  /** Wall-clock timing to persist (benchmarking story). Carried through when present. */
  timings?: CommandJournalTimings;
  /**
   * The terminal lifecycle status for this record. Defaults to `succeeded`;
   * the provider passes `failed` on a run error (stopReason 'error' / a caught
   * throw). Never `running` here — that's the INITIAL spec's job.
   */
  status?: Exclude<CommandJournalStatus, 'running'>;
  /** Injectable clock (defaults to `Date.now`) for deterministic tests. */
  now?: number;
}

/** Shape the request half, omitting empty context fields so the spec stays clean. */
function buildRequest(
  command: string,
  contextSlug: string | null,
  contextKind: string | null,
  now: number | undefined,
): CommandJournalRequest {
  const request: CommandJournalRequest = { command, ts: now ?? Date.now() };
  const slug = (contextSlug ?? '').trim();
  if (slug.length > 0) {
    request.contextSlug = slug;
  }
  const kind = (contextKind ?? '').trim();
  if (kind.length > 0) {
    request.contextKind = kind;
  }
  return request;
}

/** Inputs for the INITIAL (create-on-submit) journal spec — request only. */
export interface BuildInitialJournalSpecInput {
  workstream: string;
  command: string;
  contextSlug: string | null;
  contextKind: string | null;
  /** Injectable clock (defaults to `Date.now`) for deterministic tests. */
  now?: number;
}

/**
 * Shape the INITIAL journal spec written the moment a command is submitted
 * (two-phase write, phase 1). Status is `running` and the response is empty; the
 * FINAL spec (built by {@link buildJournalSpec}) overwrites both when the run
 * finishes. Persisting up front means a hard crash still leaves a request-only
 * `running` record instead of nothing.
 */
export function buildInitialJournalSpec(input: BuildInitialJournalSpecInput): CommandJournalSpec {
  return {
    workstream: input.workstream,
    status: 'running',
    request: buildRequest(input.command, input.contextSlug, input.contextKind, input.now),
    response: { brief: '', toolCalls: [], corrections: [], stopReason: 'running' },
  };
}

/**
 * Shape a finished request/response cycle into the FINAL `CommandJournal` spec
 * (two-phase write, phase 2) ready for `wm-document-update`. Empty/absent
 * context fields are omitted so the stored spec stays clean; token usage is
 * included only when present; `status` defaults to `succeeded`.
 */
export function buildJournalSpec(input: BuildJournalSpecInput): CommandJournalSpec {
  const request = buildRequest(input.command, input.contextSlug, input.contextKind, input.now);

  const response: CommandJournalResponse = {
    brief: input.brief,
    toolCalls: input.toolCalls,
    corrections: input.corrections,
    stopReason: input.stopReason,
  };
  if (input.tokens) {
    response.tokens = {
      promptTokens: input.tokens.promptTokens,
      evalTokens: input.tokens.evalTokens,
      calls: input.tokens.calls,
    };
  }
  if (input.timings) {
    response.timings = input.timings;
  }

  return {
    workstream: input.workstream,
    status: input.status ?? 'succeeded',
    request,
    response,
  };
}

/** A stored journal envelope narrowed to the parsed spec we care about. */
export interface CommandJournalDoc {
  id: string;
  spec: CommandJournalSpec;
}

/**
 * Narrow a raw `CommandJournal` envelope to its typed spec, or `null` when the
 * shape is unexpected (defensive — the store is schema-validated, but a legacy /
 * malformed row shouldn't crash replay).
 */
export function parseJournalDoc(doc: DocumentEnvelope): CommandJournalDoc | null {
  const spec = doc.spec as Partial<CommandJournalSpec> | undefined;
  if (!spec || typeof spec.workstream !== 'string' || !spec.request || !spec.response) {
    return null;
  }
  return { id: doc.metadata.id, spec: spec as CommandJournalSpec };
}

/**
 * Filter journal envelopes to one scope and sort them OLDEST→NEWEST by request
 * timestamp — the order the widget replays into the transcript and the model
 * sees as chat history. Ties break by document id for stability.
 */
export function filterAndSortJournals(
  docs: DocumentEnvelope[],
  workstream: string,
): CommandJournalDoc[] {
  const parsed: CommandJournalDoc[] = [];
  for (const doc of docs) {
    const j = parseJournalDoc(doc);
    if (j && j.spec.workstream === workstream) {
      parsed.push(j);
    }
  }
  parsed.sort((a, b) => {
    const dt = a.spec.request.ts - b.spec.request.ts;
    return dt !== 0 ? dt : a.id.localeCompare(b.id);
  });
  return parsed;
}

/** One replayable transcript turn for the webview (user command + brief). */
export interface JournalTurn {
  /** The underlying CommandJournal document id (for opening the record). */
  id: string;
  command: string;
  brief: string;
}

/** Map ordered journal docs into webview replay turns (oldest→newest). */
export function journalsToTurns(docs: CommandJournalDoc[]): JournalTurn[] {
  return docs.map((d) => ({
    id: d.id,
    command: d.spec.request.command,
    brief: d.spec.response.brief,
  }));
}

/**
 * Map ordered journal docs into prior-turn chat history for the tool loop
 * (context carryover baseline A). Optionally cap to the last `maxTurns` so a
 * long chat doesn't blow the local model's context window.
 */
export function journalsToHistory(docs: CommandJournalDoc[], maxTurns?: number): PriorTurn[] {
  const turns = docs.map((d) => ({
    command: d.spec.request.command,
    brief: d.spec.response.brief,
  }));
  if (maxTurns !== undefined && turns.length > maxTurns) {
    return turns.slice(turns.length - maxTurns);
  }
  return turns;
}
