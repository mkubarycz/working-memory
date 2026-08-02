/**
 * The `Nanite` kind — ONE execution instance of a {@link NaniteTemplate},
 * modeled as a control-plane document. Renamed from the OLD model's
 * "Job"/"Run"; the field shape carries over from the old `nanite_runs` table
 * (schema/018_nanites.sql) plus the required owning `workstream` + input
 * `inputTopic` refs.
 *
 * Drop-in discovered by `loader.ts`. Self-registers its own namespaced domain
 * API (`ws-nanite-*`) via `registerApi`. Nanites have NO slug (identity is the
 * store-assigned uuid `metadata.id`), like the Alert kind.
 *
 * Immutability: `workstream` + `inputTopic` are set at creation and never
 * edited — there is intentionally NO generic update tool. `workstream` is
 * REQUIRED; `inputTopic` is OPTIONAL — a Nanite may run workstream-wide with no
 * single input topic. Only `ws-nanite-run` mutates the lifecycle (`phase` +
 * timings). `spec.phase` is an AUTHORED-style lifecycle field (like Topic/Alert
 * envelope status, so the whole surface flows through the well-trodden
 * spec-write path. The real headless engine is out of scope (feature
 * `nanite-headless-runtime`); `ws-nanite-run` is a synchronous stub.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { NANITE_KIND } from './nanite.js';
import { registerWsNaniteCreate } from './create.js';
import { registerWsNaniteRead } from './read.js';
import { registerWsNaniteRun } from './run.js';
import { registerWsNaniteDelete } from './delete.js';

// Re-export the POCO interface + phase type so type consumers can import them
// from the kind entry point.
export type { INanite, NanitePhase } from './nanite.js';

const nanite: KindModule = {
  name: NANITE_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // Owning template slug/id (optional — a Nanite can be created ad-hoc).
        templateId: z.string().nullable().default(null),
        // Owning workstream slug — REQUIRED, immutable after creation.
        workstream: z.string().min(1, 'a nanite must belong to a workstream'),
        // Input topic slug — OPTIONAL, immutable after creation. When set, the
        // topic IS the input; when empty the Nanite runs workstream-wide.
        inputTopic: z.string().default(''),
        // Free-text request/prompt for this execution.
        request: z.string().default(''),
        // Lifecycle phase — AUTHORED-style spec field (mirrors Topic/Alert
        // status), NOT the controller-owned envelope status.
        phase: z.enum(['Pending', 'Queued', 'Running', 'Succeeded', 'Failed']).default('Pending'),
        // Unix seconds the nanite was enqueued for dispatch (null until Queued).
        queuedAt: z.number().nullable().default(null),
        // Run timings (unix seconds) + failure message.
        startedAt: z.number().nullable().default(null),
        endedAt: z.number().nullable().default(null),
        error: z.string().default(''),
        // Run RESULT (written by ws-nanite-run's finishing call). The real
        // engine runs in the extension host; these carry its output back.
        prompt: z.string().default(''),
        output: z.string().default(''),
        // Allow-list entries that weren't available at run time (typo / not
        // installed / MCP server down) — surfaced so a run explains itself.
        missingTools: z.array(z.string()).default([]),
        acceptance: z
          .object({
            summary: z.string(),
            confidence: z.number(),
            threshold: z.number(),
            passed: z.boolean(),
          })
          .nullable()
          .default(null),
        toolCalls: z
          .array(
            z.object({
              name: z.string(),
              ok: z.boolean(),
              error: z.string().optional(),
            }),
          )
          .default([]),
        // Ordered execution trace: the model's narration interleaved with each
        // tool call, in order. Richer than `toolCalls` — carries between-tool
        // narration and truncated arg/result previews so the full workflow can
        // be rendered inline with the response.
        steps: z
          .array(
            z.object({
              kind: z.enum(['assistant', 'tool']),
              text: z.string().optional(),
              name: z.string().optional(),
              ok: z.boolean().optional(),
              input: z.string().optional(),
              result: z.string().optional(),
              error: z.string().optional(),
            }),
          )
          .default([]),
        tokens: z
          .object({
            input_tokens: z.number(),
            output_tokens: z.number(),
            total_tokens: z.number(),
          })
          .nullable()
          .default(null),
      })
      .strict(),
    fts: (r) => `${r.spec.request}\n${r.spec.inputTopic}\n${r.spec.workstream}`,
  },
  registerApi: registerNaniteApi,
};

/**
 * Register the Nanite domain API (`ws-nanite-*`): create / read / run / delete.
 * There is no generic update tool by design (workstream + inputTopic are
 * immutable; the lifecycle is driven by `ws-nanite-run`).
 */
function registerNaniteApi(server: McpServer, store: Store): void {
  registerWsNaniteCreate(server, store);
  registerWsNaniteRead(server, store);
  registerWsNaniteRun(server, store);
  registerWsNaniteDelete(server, store);
}

export default nanite;
