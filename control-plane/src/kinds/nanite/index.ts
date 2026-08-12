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
import { registerWsNaniteUpdate } from './update.js';
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
        // Configmap slugs/ids whose merged `data` is injected into this run's
        // dev container as environment variables — IMMUTABLE after creation.
        configs: z.array(z.string()).default([]),
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
        // Light pointer to the newest NaniteJournal document for this nanite —
        // the ONLY run trace the nanite keeps. The run RESULT (output, steps,
        // acceptance, toolCalls, tokens, …) lives in the NaniteJournal record,
        // NOT here: a run appends a journal and stamps this pointer instead of
        // mutating desired-state.
        latestJournalId: z.string().nullable().default(null),
      })
      .strict(),
    fts: (r) => `${r.spec.request}\n${r.spec.inputTopic}\n${r.spec.workstream}`,
  },
  registerApi: registerNaniteApi,
};

/**
 * Register the Nanite domain API (`ws-nanite-*`): create / read / update / run /
 * delete. `ws-nanite-update` patches ONLY the mutable spec fields (`configs`,
 * `request`); `workstream` + `inputTopic` + all lifecycle fields stay immutable
 * (the lifecycle is driven by `ws-nanite-run`).
 */
function registerNaniteApi(server: McpServer, store: Store): void {
  registerWsNaniteCreate(server, store);
  registerWsNaniteRead(server, store);
  registerWsNaniteUpdate(server, store);
  registerWsNaniteRun(server, store);
  registerWsNaniteDelete(server, store);
}

export default nanite;
