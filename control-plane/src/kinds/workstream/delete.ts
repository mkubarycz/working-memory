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
 * Soft-deletes a Workstream by ID, or restores a previously deleted one.
 */
export function registerWsWorkstreamDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-workstream-delete',
    {
      title: 'Workstream: Delete',
      description:
        'Soft-delete a Workstream by `id` (it drops out of ws-workstream-read). To undelete, ' +
        'call with `restore: true`. Unknown/already-deleted IDs (or already-live IDs on ' +
        'restore) are rejected. Returns { ok, id }.',
      inputSchema: z.object({
        id: z.string().min(1).describe('ID of the workstream to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted workstream instead of deleting.'),
      }).strict(),
    },
    async ({ id, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({
        id,
        kind: WORKSTREAM_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== WORKSTREAM_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted workstream with ID "${id}" to restore.`
            : `Unknown workstream ID: "${id}". No live workstream with that ID.`,
        );
      }
      try {
        if (restore === true) {
          store.restoreDocument({ id: doc.metadata.id });
        } else {
          store.deleteDocument({ id: doc.metadata.id });
        }
        return asText({ ok: true, id });
      } catch (err) {
        if (err instanceof NotFoundError) {
          return asError(
            restore === true
              ? `No soft-deleted workstream with ID "${id}" to restore.`
              : `Unknown or already-deleted workstream ID: "${id}".`,
          );
        }
        throw err;
      }
    },
  );
}
