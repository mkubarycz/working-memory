/**
 * `ws-config-update` — the Config kind's Update tool.
 *
 * One of the four tool files in the `config/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsConfigUpdate});
 * result helpers come from `../toolResult.js` and the `Config` projection +
 * kind name from `./config.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { Config, CONFIG_KIND } from './config.js';

/**
 * Register the `ws-config-update` tool on an MCP session's server. Reads the
 * current document for its id + resourceVersion, MERGES the `data` patch onto
 * the existing map (keys in the patch overwrite; existing keys survive), and
 * REPLACES `name`/`status` when provided, re-validates the whole spec against
 * the Config kind, then does a compare-and-swap write. Unknown slug and version
 * conflicts are surfaced clearly.
 */
export function registerWsConfigUpdate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-config-update',
    {
      title: 'Config: Update',
      description:
        'Update a Config identified by `slug`. `data` is MERGED onto the existing map (keys you ' +
        'pass overwrite; existing keys survive) — every value MUST be a string. `name` and ' +
        '`status` REPLACE the current value when provided. Reads the current document for its id ' +
        '+ resourceVersion, then does a compare-and-swap write of the merged, re-validated spec. ' +
        'Unknown slug and version conflicts are surfaced clearly. Returns the updated config.',
      inputSchema: {
        slug: z.string().describe('Slug of the config to update (required).'),
        name: z.string().optional().describe('New human label (replaces the current).'),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Key-value pairs to MERGE onto the existing map. All values MUST be strings.'),
        status: z.string().optional().describe('New authored status (replaces the current).'),
      },
    },
    async ({ slug, name, data, status }) => {
      const existing = store.getDocument({ slug, kind: CONFIG_KIND });
      if (!existing) {
        return asError(`Unknown config slug: "${slug}". No live config with that slug.`);
      }
      if (name === undefined && data === undefined && status === undefined) {
        // Nothing to change: return the current mapped config rather than a
        // no-op CAS write.
        return asText(new Config(existing));
      }
      // Build the next spec: MERGE data onto the existing map; REPLACE name/status
      // when provided (else carry the existing spec value through).
      const existingSpec = existing.spec as Record<string, unknown>;
      const existingData =
        existingSpec.data && typeof existingSpec.data === 'object'
          ? (existingSpec.data as Record<string, unknown>)
          : {};
      const nextSpec: Record<string, unknown> = { ...existingSpec };
      nextSpec.data = data !== undefined ? { ...existingData, ...data } : existingData;
      if (name !== undefined) {
        nextSpec.name = name;
      }
      if (status !== undefined) {
        nextSpec.status = status;
      }
      let validatedSpec: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(CONFIG_KIND, nextSpec);
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec: validatedSpec,
        });
        return asText(new Config(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: config "${slug}" changed since it was read (current resourceVersion ` +
              `${err.currentResourceVersion}). Re-read with ws-config-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(
            `Unknown config slug: "${slug}". It no longer exists (it may have been deleted).`,
          );
        }
        throw err;
      }
    },
  );
}
