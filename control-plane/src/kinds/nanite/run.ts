/**
 * `ws-nanite-run` — the Nanite kind's manual kickoff tool.
 *
 * Transitions a Nanite OUT of `Pending`. The real headless engine is out of
 * scope (feature `nanite-headless-runtime`); this is a synchronous STUB that
 * walks the lifecycle Pending → Running → (Succeeded | Failed) in one call,
 * stamping `startedAt` / `endedAt`. Refuses when the Nanite is not currently
 * `Pending` (idempotent guard — a Nanite runs once).
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
        'Advance a Nanite one lifecycle step (STUB execution — the real engine is out of scope): ' +
        'Pending → Running on the first call, Running → terminal on the next, stamping timings. ' +
        "On the finishing call pass `outcome` ('succeeded' | 'failed', default 'succeeded') and " +
        'optional `error` text. Returns the updated nanite.',
      inputSchema: {
        id: z.string().describe('Document id of the nanite to run (required).'),
        outcome: z
          .enum(['succeeded', 'failed'])
          .optional()
          .describe("Terminal phase to land in (default 'succeeded')."),
        error: z.string().optional().describe('Failure message (used when outcome is failed).'),
      },
    },
    async ({ id, outcome, error }) => {
      const existing = store.getDocument({ id, kind: NANITE_KIND });
      if (!existing || existing.kind !== NANITE_KIND) {
        return asError(`Unknown nanite id: "${id}". No live nanite with that id.`);
      }
      const phase = existing.spec?.phase;
      // Advance ONE step per call so the Running state is observable in the
      // panel: Pending → Running (start), then Running → terminal (finish).
      let mergedSpec: Record<string, unknown>;
      if (phase === 'Pending') {
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
