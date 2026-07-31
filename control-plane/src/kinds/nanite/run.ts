/**
 * `ws-nanite-run` — the Nanite kind's manual kickoff + result-persistence tool.
 *
 * Walks the lifecycle Pending → Running → (Succeeded | Failed), stamping
 * `startedAt` / `endedAt`. It is a persistence PRIMITIVE, not the engine: the
 * real headless engine (the extension-host runner in `src/nanites/`) drives the
 * model + tools, then calls this tool's finishing step to record the terminal
 * phase plus the run RESULT (`output`, `acceptance`, `toolCalls`, `tokens`).
 * Refuses when the Nanite is not currently `Pending`/`Running` (idempotent
 * guard — a Nanite runs once).
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
        'The finishing call (Running → terminal) carries `outcome` + the run RESULT (`output`, ' +
        '`acceptance`, `toolCalls`, `tokens`). `reset` returns to Pending. Returns the updated nanite.',
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
        prompt: z
          .string()
          .optional()
          .describe('The full request text sent to the model, instructions + context (finishing call).'),
        output: z
          .string()
          .optional()
          .describe('The run\'s verbatim final text (finishing call).'),
        acceptance: z
          .object({
            summary: z.string(),
            confidence: z.number(),
            threshold: z.number(),
            passed: z.boolean(),
          })
          .nullable()
          .optional()
          .describe('The acceptance-judge verdict (finishing call).'),
        toolCalls: z
          .array(
            z.object({
              name: z.string(),
              ok: z.boolean(),
              error: z.string().optional(),
            }),
          )
          .optional()
          .describe('The run\'s tool-call trail (finishing call).'),
        missingTools: z
          .array(z.string())
          .optional()
          .describe('Allow-list entries that were unavailable at run time (finishing call).'),
        tokens: z
          .object({
            input_tokens: z.number(),
            output_tokens: z.number(),
            total_tokens: z.number(),
          })
          .nullable()
          .optional()
          .describe('Approximate token usage, loop + judge (finishing call).'),
        reset: z
          .boolean()
          .optional()
          .describe('Reset the nanite back to Pending from ANY phase (clears timings + result) so it can be re-run. Use to clear a stuck Running nanite.'),
      },
    },
    async ({ id, begin, approved, outcome, error, prompt, output, acceptance, toolCalls, missingTools, tokens, reset }) => {
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
        // Return to Pending from any phase (clears a stuck run).
        mergedSpec = {
          ...existing.spec,
          phase: 'Pending',
          queuedAt: null,
          startedAt: null,
          endedAt: null,
          error: '',
          output: '',
          acceptance: null,
          toolCalls: [],
          missingTools: [],
          tokens: null,
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
        // Finishing call (Running → terminal), carrying the run result.
        mergedSpec = {
          ...existing.spec,
          phase: outcome === 'failed' ? 'Failed' : 'Succeeded',
          endedAt: nowSeconds(),
          error: outcome === 'failed' ? (error ?? 'Nanite failed.') : '',
          // Persist the run result carried by the finishing call. Absent fields
          // fall back to whatever the spec already held (defaults on create).
          ...(prompt !== undefined ? { prompt } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(acceptance !== undefined ? { acceptance } : {}),
          ...(toolCalls !== undefined ? { toolCalls } : {}),
          ...(missingTools !== undefined ? { missingTools } : {}),
          ...(tokens !== undefined ? { tokens } : {}),
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
