/**
 * `ws-nanite-run` — the Nanite kind's manual kickoff + result-persistence tool.
 *
 * Walks the lifecycle Pending → Running → (Succeeded | Failed), stamping
 * `startedAt` / `endedAt`. It is a persistence PRIMITIVE, not the engine: the
 * real headless engine (the extension-host runner in `src/nanites/`) drives the
 * model + tools, appends the run's {@link NaniteJournal} record, then calls this
 * tool's finishing step to record the terminal phase plus a light
 * `latestJournalId` pointer to that record. The run RESULT itself (output,
 * steps, acceptance, toolCalls, tokens, …) NEVER lands on the nanite spec —
 * only the pointer does. Refuses when the Nanite is not currently
 * `Pending`/`Running` (idempotent guard — a Nanite runs once).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { asText, asError } from '../toolResult.js';
import { Nanite, NANITE_KIND } from './nanite.js';

/** Current unix time in whole seconds (the store's timestamp unit). */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Whether the owning template opts into unattended (no-human) dispatch. */
function templateAllowsUnattended(store: Store, templateId: unknown): boolean {
  if (typeof templateId !== 'string' || templateId === '') {
    return false;
  }
  const doc =
    store.getDocument({ slug: templateId, kind: 'NaniteTemplate' }) ??
    store.getDocument({ id: templateId, kind: 'NaniteTemplate' });
  return doc?.spec?.allowRunWithoutHuman === true;
}

/** Register the `ws-nanite-run` tool. */
export function registerWsNaniteRun(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanite-run',
    {
      title: 'Nanite: Run',
      description:
        'Advance a Nanite through its lifecycle: Pending → Queued → Running → terminal. A bare ' +
        'call ENQUEUES a Pending nanite for the extension-host dispatcher, but only with human ' +
        'approval (`approved: true`, set by the Run action) OR when the owning template sets ' +
        '`allowRunWithoutHuman` — otherwise it is rejected (the nanite stays Pending). `begin: true` ' +
        '(dispatcher/engine only) starts execution (→ Running); the control plane cannot run models. ' +
        'The finishing call (Running → terminal) carries `outcome` + a light `latestJournalId` ' +
        'pointer to the run\'s NaniteJournal record (the run RESULT lives in that record, never ' +
        'on the nanite spec). `reset` returns to Pending. Returns the updated nanite.',
      inputSchema: {
        id: z.string().describe('Document id of the nanite to run (required).'),
        approved: z
          .boolean()
          .optional()
          .describe('Reserved for the extension-host Run action (human approval). Do NOT set this from a nanite or agent tool call — nanite-originated calls have it stripped, and it does not grant unattended dispatch (use the template allowRunWithoutHuman flag for that).'),
        begin: z
          .boolean()
          .optional()
          .describe('Set by the extension-host engine to START execution (Pending → Running). A start without it is rejected — the control plane cannot run models.'),
        outcome: z
          .enum(['succeeded', 'failed'])
          .optional()
          .describe("Terminal phase to land in (default 'succeeded')."),
        error: z.string().optional().describe('Failure message (used when outcome is failed).'),
        latestJournalId: z
          .string()
          .optional()
          .describe("Document id of the run's NaniteJournal record (finishing call). Stored as a light pointer to the newest run; the result itself lives in that journal."),
        reset: z
          .boolean()
          .optional()
          .describe('Reset the nanite back to Pending from ANY phase (clears timings + latest-run pointer) so it can be re-run. Use to clear a stuck Running nanite.'),
      },
    },
    async ({ id, begin, approved, outcome, error, latestJournalId, reset }) => {
      const existing = store.getDocument({ id, kind: NANITE_KIND });
      if (!existing || existing.kind !== NANITE_KIND) {
        return asError(`Unknown nanite id: "${id}". No live nanite with that id.`);
      }
      const phase = existing.spec?.phase;
      // Lifecycle: Pending → Queued (enqueue) → Running (begin) → terminal.
      // Execution happens ONLY in the extension host; the control plane just
      // records phases. `begin` is set by the dispatcher/runner; a bare call
      // ENQUEUES (gated by human approval / the template flag).
      let mergedSpec: Record<string, unknown>;
      if (reset) {
        // Return to Pending from any phase (clears a stuck run + its pointer).
        mergedSpec = {
          ...existing.spec,
          phase: 'Pending',
          queuedAt: null,
          startedAt: null,
          endedAt: null,
          error: '',
          latestJournalId: null,
        };
      } else if (begin) {
        // The extension-host engine is STARTING execution (Pending|Queued → Running).
        if (phase !== 'Pending' && phase !== 'Queued') {
          return asError(
            `Cannot start nanite "${id}": phase is "${String(phase)}" (only Pending/Queued can start).`,
          );
        }
        mergedSpec = {
          ...existing.spec,
          phase: 'Running',
          startedAt: nowSeconds(),
          endedAt: null,
          error: '',
        };
      } else if (phase === 'Running') {
        // Finishing call (Running → terminal). The run RESULT lives in the
        // run's NaniteJournal record; the nanite keeps only a light pointer.
        mergedSpec = {
          ...existing.spec,
          phase: outcome === 'failed' ? 'Failed' : 'Succeeded',
          endedAt: nowSeconds(),
          error: outcome === 'failed' ? (error ?? 'Nanite failed.') : '',
          ...(latestJournalId !== undefined ? { latestJournalId } : {}),
        };
      } else if (phase === 'Queued') {
        // Already queued — a bare re-enqueue is an idempotent no-op.
        return asText(new Nanite(existing));
      } else if (phase === 'Pending') {
        // ENQUEUE for dispatch. The control plane cannot run models, so a bare
        // start can't execute; instead we queue it for the extension-host
        // dispatcher — but ONLY with human approval (`approved`, set by the Run
        // action) or when the owning template opts into unattended runs.
        if (approved !== true && !templateAllowsUnattended(store, existing.spec?.templateId)) {
          return asError(
            `Nanite "${id}" needs human approval to run. Start it with the Run action ` +
              '(or set the template\'s `allowRunWithoutHuman` to enable unattended dispatch).',
          );
        }
        mergedSpec = {
          ...existing.spec,
          phase: 'Queued',
          queuedAt: nowSeconds(),
        };
      } else {
        return asError(
          `Nanite "${id}" already finished (phase is "${String(phase)}") — a nanite runs once.`,
        );
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec: mergedSpec,
        });
        return asText(new Nanite(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: nanite "${id}" changed since it was read (current resourceVersion ` +
              `${err.currentResourceVersion}). Re-read with ws-nanite-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(`Unknown nanite id: "${id}". It no longer exists.`);
        }
        throw err;
      }
    },
  );
}
