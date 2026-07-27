/**
 * `ws-workstream-delete` — the Workstream kind's Delete/Restore tool.
 *
 * One of the four tool files in the `workstream/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsWorkstreamDelete});
 * shared helpers come from `./shared.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, NotFoundError } from '../../store.js';
import { WORKSTREAM_KIND, asText, asError } from './shared.js';

/**
 * Register the `ws-workstream-delete` tool on an MCP session's server.
 * Soft-deletes a Workstream by slug, or — with `restore: true` — undeletes a
 * previously soft-deleted one. Unknown/already-deleted slug (or an already-live
 * slug on restore) is rejected.
 */
export function registerWsWorkstreamDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-workstream-delete',
    {
      title: 'Workstream: Delete',
      description:
        'Soft-delete a Workstream by `slug` (it drops out of ws-workstream-read). To undelete, ' +
        'call with `restore: true`. Unknown/already-deleted slug (or an already-live slug on ' +
        'restore) is rejected. Returns { ok, slug }.',
      inputSchema: {
        slug: z.string().describe('Slug of the workstream to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted workstream instead of deleting.'),
      },
    },
    async ({ slug, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({
        slug,
        kind: WORKSTREAM_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== WORKSTREAM_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted workstream with slug "${slug}" to restore.`
            : `Unknown workstream slug: "${slug}". No live workstream with that slug.`,
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
              ? `No soft-deleted workstream with slug "${slug}" to restore.`
              : `Unknown or already-deleted workstream slug: "${slug}".`,
          );
        }
        throw err;
      }
    },
  );
}
