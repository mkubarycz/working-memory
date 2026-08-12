/**
 * The `NaniteJournal` kind — ONE immutable record of a single {@link Nanite}
 * run, modeled as a control-plane document. A run NEVER mutates the nanite spec
 * (desired-state); it appends a NaniteJournal referencing its owning `naniteId`
 * + `workstream` + `inputTopic`, and the nanite keeps only a light
 * `latestJournalId` pointer.
 *
 * The spec is organized into FOUR sections — `status`, `prompt`, `execution`,
 * `results` — see {@link ./naniteJournal.js} for the section shapes.
 *
 * Drop-in discovered by `loader.ts`. Self-registers its own namespaced domain
 * API (`ws-nanitejournal-*`) via `registerApi`. Journals have NO slug (identity
 * is the store-assigned uuid `metadata.id`), like the Nanite + Alert kinds. The
 * API is create + read only (records are immutable — there is no update/delete
 * tool); read fetches one by id OR lists by `naniteId`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { NANITE_JOURNAL_KIND } from './naniteJournal.js';
import { registerWsNaniteJournalCreate } from './create.js';
import { registerWsNaniteJournalRead } from './read.js';

// Re-export the POCO interface so type consumers can import it from the kind
// entry point (mirrors the Nanite + Config kinds).
export type { INaniteJournal } from './naniteJournal.js';

/** The acceptance-judge verdict sub-schema (mirrors the Nanite kind). */
const acceptance = z
  .object({
    summary: z.string(),
    confidence: z.number(),
    threshold: z.number(),
    passed: z.boolean(),
  })
  .nullable()
  .default(null);

/** The ordered execution-trace sub-schema (mirrors the Nanite kind). */
const steps = z
  .array(
    z.object({
      kind: z.enum(['assistant', 'tool']),
      round: z.number().optional(),
      text: z.string().optional(),
      name: z.string().optional(),
      ok: z.boolean().optional(),
      input: z.string().optional(),
      result: z.string().optional(),
      error: z.string().optional(),
      resultDigest: z
        .object({
          count: z.number(),
          items: z
            .array(
              z.object({
                id: z.string().optional(),
                slug: z.string().optional(),
                title: z.string().optional(),
                name: z.string().optional(),
                resourceVersion: z.number().optional(),
              }),
            )
            .default([]),
        })
        .optional(),
    }),
  )
  .default([]);

/** Approximate token usage sub-schema (mirrors the Nanite kind). */
const tokens = z
  .object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    total_tokens: z.number(),
  })
  .nullable()
  .default(null);

const naniteJournal: KindModule = {
  name: NANITE_JOURNAL_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // The owning nanite's document id — REQUIRED (a journal is always a
        // record OF a run).
        naniteId: z.string().min(1, 'a nanite journal must reference a nanite'),
        // Scope refs carried from the nanite (empty inputTopic ⇒ workstream-wide).
        workstream: z.string().default(''),
        inputTopic: z.string().default(''),
        // Section 1 — phase/outcome + timing.
        status: z
          .object({
            phase: z
              .enum(['Pending', 'Queued', 'Running', 'Succeeded', 'Failed'])
              .default('Pending'),
            outcome: z.enum(['succeeded', 'failed']).nullable().default(null),
            queuedAt: z.number().nullable().default(null),
            startedAt: z.number().nullable().default(null),
            endedAt: z.number().nullable().default(null),
          })
          .strip()
          .default({ phase: 'Pending', outcome: null, queuedAt: null, startedAt: null, endedAt: null }),
        // Section 2 — all run input (full instructions + context sent to model).
        prompt: z
          .object({
            request: z.string().default(''),
          })
          .strip()
          .default({ request: '' }),
        // Section 3 — the turn trace + any error encountered.
        execution: z
          .object({
            steps,
            error: z.string().default(''),
          })
          .strip()
          .default({ steps: [], error: '' }),
        // Section 4 — summary, acceptance verdict, and execution stats.
        results: z
          .object({
            summary: z.string().default(''),
            acceptance,
            tokens,
            missingTools: z.array(z.string()).default([]),
          })
          .strip()
          .default({ summary: '', acceptance: null, tokens: null, missingTools: [] }),
      })
      .strict(),
    // Content, not controller-driven → inherit Base's empty `{}` status. FTS
    // projects the scope + the human-readable summary (never the full prompt).
    fts: (r) =>
      [r.spec?.naniteId, r.spec?.workstream, r.spec?.inputTopic, r.spec?.results?.summary]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n'),
  },
  registerApi: registerNaniteJournalApi,
};

/**
 * Register the NaniteJournal domain API (`ws-nanitejournal-*`): create + read.
 * Records are immutable, so there is intentionally NO update or delete tool.
 */
function registerNaniteJournalApi(server: McpServer, store: Store): void {
  registerWsNaniteJournalCreate(server, store);
  registerWsNaniteJournalRead(server, store);
}

export default naniteJournal;
