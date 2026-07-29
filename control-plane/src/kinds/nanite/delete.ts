/**
 * `ws-nanite-delete` — the Nanite kind's Delete/Restore tool.
 *
 * Soft-deletes a Nanite by id, or — with `restore: true` — undeletes one.
 * Mirrors `ws-alert-delete` (id-based identity).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, NotFoundError } from '../../store.js';
import { asText, asError } from '../toolResult.js';
import { NANITE_KIND } from './nanite.js';

/** Register the `ws-nanite-delete` tool. */
export function registerWsNaniteDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanite-delete',
    {
      title: 'Nanite: Delete',
      description:
        'Soft-delete a Nanite by `id` (it drops out of ws-nanite-read). To undelete, call with ' +
        '`restore: true`. Returns { ok, id }.',
      inputSchema: {
        id: z.string().describe('Document id of the nanite to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted nanite instead of deleting.'),
      },
    },
    async ({ id, restore }) => {
      const doc = store.getDocument({ id, kind: NANITE_KIND, includeDeleted: restore === true });
      if (!doc || doc.kind !== NANITE_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted nanite with id "${id}" to restore.`
            : `Unknown nanite id: "${id}". No live nanite with that id.`,
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
              ? `No soft-deleted nanite with id "${id}" to restore.`
              : `Unknown or already-deleted nanite id: "${id}".`,
          );
        }
        throw err;
      }
    },
  );
}
