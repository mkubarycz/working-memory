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
        'Advance a Nanite one lifecycle step: ' +
        'Pending → Running on the first call, Running → terminal on the next, stamping timings. ' +
        "On the finishing call pass `outcome` ('succeeded' | 'failed', default 'succeeded'), " +
        'optional `error` text, and the run RESULT — `output`, `acceptance`, `toolCalls`, `tokens` ' +
        '(written by the extension-host engine). Returns the updated nanite.',
      inputSchema: {
        id: z.string().describe('Document id of the nanite to run (required).'),
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
    async ({ id, outcome, error, prompt, output, acceptance, toolCalls, tokens, reset }) => {
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
          tokens: null,
        };
      } else if (phase === 'Pending') {
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
