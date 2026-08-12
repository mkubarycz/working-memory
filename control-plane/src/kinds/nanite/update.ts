/**
 * `ws-nanite-update` — the Nanite kind's Update tool.
 *
 * Patches a Nanite's mutable spec fields IN PLACE. Only `configs` (the
 * configmap slugs/ids injected into the run's dev container as env) and
 * `request` (the free-text prompt) are patchable. Everything else —
 * `workstream`, `inputTopic`, `templateId`, and every lifecycle/result field
 * (`phase`, `queuedAt`, `startedAt`, `endedAt`, `output`, `steps`, …) — is
 * IMMUTABLE: those keys are not in the input schema, so callers cannot change
 * them (they are simply ignored) and the merge preserves whatever the spec
 * already held.
 *
 * Reads the current document (by id) for its resourceVersion, merges the patch,
 * re-validates the whole spec against the Nanite kind schema, then does a
 * compare-and-swap write. Accepts an optional `expectedResourceVersion` so a
 * caller can supply its own CAS guard (rejected up front on mismatch); when
 * omitted it falls back to the read version, mirroring `ws-nanitetemplate-update`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { Nanite, NANITE_KIND } from './nanite.js';

/**
 * Run-result keys that used to live on the Nanite spec but moved to the
 * NaniteJournal kind. An old nanite document may still carry them; the strict
 * Nanite schema now rejects them, so they're dropped before re-validation.
 */
const LEGACY_RUN_KEYS = [
  'prompt',
  'output',
  'missingTools',
  'acceptance',
  'toolCalls',
  'steps',
  'tokens',
] as const;

/** Return a copy of `spec` with the legacy run-result keys removed. */
function stripLegacyRunKeys(spec: Record<string, unknown>): Record<string, unknown> {
  const out = { ...spec };
  for (const key of LEGACY_RUN_KEYS) {
    delete out[key];
  }
  return out;
}

/** Register the `ws-nanite-update` tool. */
export function registerWsNaniteUpdate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanite-update',
    {
      title: 'Nanite: Update',
      description:
        'Update a Nanite identified by `id`, changing only its mutable fields: `configs` (the ' +
        'configmap slugs/ids injected into the run container as env) and/or `request` (the ' +
        'free-text prompt). `workstream`, `inputTopic`, `templateId`, and all lifecycle/result ' +
        'fields (`phase`, timings, `output`, `steps`, …) are IMMUTABLE and cannot be changed here — ' +
        'use ws-nanite-run to advance the lifecycle. Pass only the fields you are changing; the ' +
        'rest of the spec is preserved. Optionally supply `expectedResourceVersion` for a ' +
        'compare-and-swap guard (a stale value is rejected as a conflict). Returns the updated nanite.',
      inputSchema: {
        id: z.string().describe('Document id of the nanite to update (required).'),
        expectedResourceVersion: z
          .number()
          .optional()
          .describe(
            'Optional CAS guard — the resourceVersion the caller last read. A stale value is ' +
              'rejected as a conflict. When omitted, the current stored version is used.',
          ),
        configs: z
          .array(z.string())
          .optional()
          .describe('Replacement configmap slugs/ids injected into the run container as env.'),
        request: z.string().optional().describe('New free-text request/prompt for this execution.'),
      },
    },
    async ({ id, expectedResourceVersion, configs, request }) => {
      const existing = store.getDocument({ id, kind: NANITE_KIND });
      if (!existing || existing.kind !== NANITE_KIND) {
        return asError(`Unknown nanite id: "${id}". No live nanite with that id.`);
      }
      // Up-front CAS guard when the caller supplied an expected version, so a
      // stale read is rejected as a conflict before we attempt the write.
      if (
        expectedResourceVersion !== undefined &&
        expectedResourceVersion !== existing.metadata.resourceVersion
      ) {
        return asError(
          `Conflict: nanite "${id}" changed since it was read (current resourceVersion ` +
            `${existing.metadata.resourceVersion}, expected ${expectedResourceVersion}). ` +
            'Re-read with ws-nanite-read and retry.',
        );
      }
      // Only `configs` + `request` are patchable; everything else is immutable
      // and preserved by the merge below.
      const patch: Record<string, unknown> = {};
      if (configs !== undefined) {
        patch.configs = configs;
      }
      if (request !== undefined) {
        patch.request = request;
      }
      if (Object.keys(patch).length === 0) {
        return asText(new Nanite(existing));
      }
      let validatedSpec: Record<string, unknown>;
      try {
        // Strip legacy run-result keys that moved to the NaniteJournal kind:
        // an old nanite document (written before the trim) may still carry
        // them, and the strict Nanite schema would now reject the merge.
        const merged = stripLegacyRunKeys({ ...existing.spec, ...patch });
        validatedSpec = validateSpec(NANITE_KIND, merged);
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: expectedResourceVersion ?? existing.metadata.resourceVersion,
          spec: validatedSpec,
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
