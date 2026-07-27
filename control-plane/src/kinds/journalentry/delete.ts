/**
 * `ws-journalentry-delete` — the JournalEntry kind's Delete/Restore tool.
 *
 * One of the four tool files in the `journalentry/` kind folder. Registered by
 * the folder's `index.ts` `registerApi` (which calls
 * {@link registerWsJournalEntryDelete}); result helpers come from
 * `../toolResult.js` and the kind name from `./journalentry.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, NotFoundError } from '../../store.js';
import { asText, asError } from '../toolResult.js';
import { JOURNAL_ENTRY_KIND } from './journalentry.js';

/**
 * Register the `ws-journalentry-delete` tool on an MCP session's server.
 * Soft-deletes a JournalEntry by id, or — with `restore: true` — undeletes a
 * previously soft-deleted one. Unknown/already-deleted id (or an already-live id
 * on restore) is rejected.
 */
export function registerWsJournalEntryDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-journalentry-delete',
    {
      title: 'JournalEntry: Delete',
      description:
        'Soft-delete a JournalEntry by `id` (it drops out of ws-journalentry-read). To undelete, ' +
        'call with `restore: true`. Unknown/already-deleted id (or an already-live id on restore) ' +
        'is rejected. Returns { ok, id }.',
      inputSchema: {
        id: z.string().describe('Document id of the entry to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted entry instead of deleting.'),
      },
    },
    async ({ id, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({
        id,
        kind: JOURNAL_ENTRY_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== JOURNAL_ENTRY_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted entry with id "${id}" to restore.`
            : `Unknown entry id: "${id}". No live entry with that id.`,
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
              ? `No soft-deleted entry with id "${id}" to restore.`
              : `Unknown or already-deleted entry id: "${id}".`,
          );
        }
        throw err;
      }
    },
  );
}
