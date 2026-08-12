/**
 * The `CommandJournal` kind — one document per command-widget request/response
 * cycle, so the right-rail chat transcript becomes DURABLE and REPLAYABLE
 * instead of ephemeral in-memory state (POC: `command-journal-document-kind`).
 *
 * A journal doc holds BOTH the `request` (the command + its scope + timestamp)
 * and the `response` (the rendered brief, the tool-call trail, any failed-call
 * → corrective-retry `corrections`, the stop reason, and optional token usage).
 * It is scoped by `workstream` (the tracking key): the widget reads a scope's
 * journal on load / scope-change and replays it oldest→newest into the chat.
 *
 * Drop-in discovered by `loader.ts` (no registration list to edit) and needs NO
 * migration — the control-plane has ZERO DDL per kind; everything is validated
 * and projected in code over the single unified `resources` table. This kind
 * contributes ONLY the generic `wm-document-*` surface (create + read-by-kind is
 * all the POC needs); a typed `ws-commandjournal-*` API can be added later if
 * the shape settles.
 *
 * No `validateMetadata` slug guard: journal docs are per-turn and identified by
 * id, not by a human slug, so `slug` is left null.
 */

import { z } from 'zod';
import { Base, type KindModule } from '../base.js';

export const COMMAND_JOURNAL_KIND = 'CommandJournal';

/** One tool call in the journaled trail (mirrors the loop's ToolCallRecord). */
const toolCall = z
  .object({
    name: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
    ok: z.boolean(),
    deduped: z.boolean().optional(),
    destructive: z.boolean().optional(),
    error: z.string().optional(),
  })
  .strip();

/** One failed-call → corrective-retry record (self-correction story). */
const correction = z
  .object({
    tool: z.string(),
    /** The args that failed validation/execution. */
    failedArgs: z.record(z.string(), z.unknown()).default({}),
    /** The error the tool returned. */
    error: z.string(),
    /** The corrective hint fed back to the model (schema + instruction). */
    hint: z.string().optional(),
    /** The args of the corrected retry (present when the model retried). */
    retriedArgs: z.record(z.string(), z.unknown()).optional(),
    /** Whether a later call to the same tool succeeded within the run. */
    recovered: z.boolean(),
  })
  .strip();

const commandJournal: KindModule = {
  name: COMMAND_JOURNAL_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // The scope key this turn belongs to (the tracking dimension). For the
        // POC this is the widget's context slug (topic OR workstream); unscoped
        // turns bucket under a sentinel key.
        workstream: z.string().min(1),
        // The turn's lifecycle: 'running' the moment the request is journaled
        // (two-phase write — create-on-submit), then 'succeeded'/'failed' when
        // the run finishes and the record is updated. This is a SPEC field
        // (authored content), NOT the controller-owned envelope status.
        // `.default('running')` keeps back-compat: pre-two-phase docs written
        // without it still parse (and read as a finished, non-'running' turn is
        // impossible for them — they were only ever written once, at the end).
        status: z.enum(['running', 'succeeded', 'failed']).default('running'),
        request: z
          .object({
            command: z.string(),
            contextSlug: z.string().optional(),
            contextKind: z.string().optional(),
            // Unix ms — the replay ordering key.
            ts: z.number(),
          })
          .strip(),
        response: z
          .object({
            /** The rendered markdown brief (replayed verbatim into the chat). */
            brief: z.string().default(''),
            toolCalls: z.array(toolCall).default([]),
            corrections: z.array(correction).default([]),
            stopReason: z.string().default('final'),
            /** Optional token accounting for context-window instrumentation. */
            tokens: z
              .object({
                promptTokens: z.number().optional(),
                evalTokens: z.number().optional(),
                calls: z.number().optional(),
              })
              .strip()
              .optional(),
            /** Optional wall-clock timing (ms) for the run (benchmarking story). */
            timings: z
              .object({
                totalMs: z.number().optional(),
                modelMs: z.number().optional(),
                modelCalls: z.number().optional(),
                journalReadMs: z.number().optional(),
                journalWriteMs: z.number().optional(),
                toolsMs: z.number().optional(),
              })
              .strip()
              .optional(),
            /**
             * When this turn is a nanite run, the run's NaniteJournal document
             * id — the transcript turn links out to that record. Absent for
             * ordinary command turns. (Must be declared: the spec is `.strip()`,
             * so an undeclared field would be dropped on write.)
             */
            naniteJournalId: z.string().optional(),
          })
          .strip(),
      })
      .strict(),
    // Content, not controller-driven → inherit Base's empty `{}` status.
    fts: (r) => `${r.spec?.request?.command ?? ''}\n${r.spec?.response?.brief ?? ''}`,
  },
};

export default commandJournal;
