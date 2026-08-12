/**
 * `ws-config-delete` — the Config kind's Delete/Restore tool.
 *
 * One of the four tool files in the `config/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsConfigDelete});
 * result helpers come from `../toolResult.js` and the kind name from
 * `./config.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, NotFoundError } from '../../store.js';
import { asText, asError } from '../toolResult.js';
import { CONFIG_KIND } from './config.js';

/**
 * Register the `ws-config-delete` tool on an MCP session's server. Soft-deletes
 * a Config by slug, or — with `restore: true` — undeletes a previously
 * soft-deleted one. Unknown/already-deleted slug (or an already-live slug on
 * restore) is rejected.
 */
export function registerWsConfigDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-config-delete',
    {
      title: 'Config: Delete',
      description:
        'Soft-delete a Config by `slug` (it drops out of ws-config-read). To undelete, call with ' +
        '`restore: true`. Unknown/already-deleted slug (or an already-live slug on restore) is ' +
        'rejected. Returns { ok, slug }.',
      inputSchema: {
        slug: z.string().describe('Slug of the config to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted config instead of deleting.'),
      },
    },
    async ({ slug, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({
        slug,
        kind: CONFIG_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== CONFIG_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted config with slug "${slug}" to restore.`
            : `Unknown config slug: "${slug}". No live config with that slug.`,
        );
      }
      try {
        if (restore === true) {
          store.restoreDocument({ id: doc.metadata.id });
        } else {
          store.deleteDocument({ id: doc.metadata.id });
        }
        return asText({ ok: true, slug });
      } catch (err) {
        if (err instanceof NotFoundError) {
          return asError(
            restore === true
              ? `No soft-deleted config with slug "${slug}" to restore.`
              : `Unknown or already-deleted config slug: "${slug}".`,
          );
        }
        throw err;
      }
    },
  );
}
