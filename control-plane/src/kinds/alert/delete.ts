/**
 * `ws-alert-delete` — the Alert kind's Delete/Restore tool.
 *
 * One of the four tool files in the `alert/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsAlertDelete});
 * result helpers come from `../toolResult.js` and the kind name from `./alert.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, NotFoundError } from '../../store.js';
import { asText, asError } from '../toolResult.js';
import { ALERT_KIND } from './alert.js';

/**
 * Register the `ws-alert-delete` tool on an MCP session's server. Soft-deletes
 * an Alert by id, or — with `restore: true` — undeletes a previously
 * soft-deleted one. Unknown/already-deleted id (or an already-live id on
 * restore) is rejected.
 */
export function registerWsAlertDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-alert-delete',
    {
      title: 'Alert: Delete',
      description:
        'Soft-delete an Alert by `id` (it drops out of ws-alert-read). To undelete, call with ' +
        '`restore: true`. Unknown/already-deleted id (or an already-live id on restore) is ' +
        'rejected. Returns { ok, id }.',
      inputSchema: {
        id: z.string().describe('Document id of the alert to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted alert instead of deleting.'),
      },
    },
    async ({ id, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({ id, kind: ALERT_KIND, includeDeleted: restore === true });
      if (!doc || doc.kind !== ALERT_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted alert with id "${id}" to restore.`
            : `Unknown alert id: "${id}". No live alert with that id.`,
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
              ? `No soft-deleted alert with id "${id}" to restore.`
              : `Unknown or already-deleted alert id: "${id}".`,
          );
        }
        throw err;
      }
    },
  );
}
