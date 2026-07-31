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

/** Register the `ws-nanite-run` tool. */
export function registerWsNaniteRun(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanite-run',
    {
      title: 'Nanite: Run',
      description:
        'Advance a Nanite one lifecycle step. STARTING a nanite (Pending → Running) requires ' +
        '`begin: true` and is done ONLY by the extension-host engine, which actually runs the ' +
        'model — the control plane cannot execute. A bare start (no `begin`) is rejected: to run a ' +
        'nanite use the Run action / `workingMemory.nanite.run` command. This tool also does ' +
        'Running → terminal on the finishing call (pass `outcome`, plus the run RESULT: `output`, ' +
        '`acceptance`, `toolCalls`, `tokens`) and `reset` (→ Pending). Returns the updated nanite.',
      inputSchema: {
        id: z.string().describe('Document id of the nanite to run (required).'),
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
    async ({ id, begin, outcome, error, prompt, output, acceptance, toolCalls, missingTools, tokens, reset }) => {
      const existing = store.getDocument({ id, kind: NANITE_KIND });
      if (!existing || existing.kind !== NANITE_KIND) {
        return asError(`Unknown nanite id: "${id}". No live nanite with that id.`);
      }
      const phase = existing.spec?.phase;
      // Advance ONE step per call so the Running state is observable in the
      // panel: Pending → Running (start), then Running → terminal (finish).
      let mergedSpec: Record<string, unknown>;
      if (reset) {
        // Return to Pending from any phase (clears a stuck Running nanite).
        mergedSpec = {
          ...existing.spec,
          phase: 'Pending',
          startedAt: null,
          endedAt: null,
          error: '',
          output: '',
          acceptance: null,
          toolCalls: [],
          missingTools: [],
          tokens: null,
        };
      } else if (phase === 'Pending') {
        // Only the extension-host engine may START a nanite (it runs the model,
        // then records the result here). A start from anywhere else — e.g. an
        // agent or a parent nanite — would flip the phase with NOTHING to
        // execute it, stranding the child in Running. Reject it loudly.
        if (!begin) {
          return asError(
            `Cannot start nanite "${id}" via ws-nanite-run: the control plane cannot run models. ` +
              'Start it with the Run action or the workingMemory.nanite.run command (the extension ' +
              'host executes it). ws-nanite-run supports `reset` and result-recording only.',
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
