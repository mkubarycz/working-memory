/**
 * `ws-journalentry-read` — the JournalEntry kind's Read/List tool.
 *
 * One of the four tool files in the `journalentry/` kind folder. Registered by
 * the folder's `index.ts` `registerApi` (which calls
 * {@link registerWsJournalEntryRead}); result helpers come from
 * `../toolResult.js` and the `JournalEntry` projection + kind name from
 * `./journalentry.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { asText } from '../toolResult.js';
import { JournalEntry, JOURNAL_ENTRY_KIND } from './journalentry.js';

/**
 * Register the `ws-journalentry-read` tool on an MCP session's server. Reads ONE
 * entry by id, or LISTs all live entries (optionally filtered), always returning
 * the uniform `{ count, journalEntries }` shape.
 */
export function registerWsJournalEntryRead(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-journalentry-read',
    {
      title: 'JournalEntry: Read',
      description:
        'Read one JournalEntry or many. Read ONE by `id`; otherwise LIST all entries (newest-first), ' +
        'with an optional `query` case-insensitive substring filter and a `limit`. ALWAYS returns ' +
        '{ count, journalEntries } — a by-id read yields a 0-or-1 element list, so callers get one ' +
        'uniform shape.',
      inputSchema: {
        id: z.string().optional().describe('Read ONE entry by document id (uuid).'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter over entry text (list mode only).'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max entries to return (list mode only).'),
      },
    },
    async ({ id, query, limit }) => {
      // Single read: by id (kind-agnostic in the store, so guard the kind here).
      if (id !== undefined) {
        const doc = store.getDocument({ id, kind: JOURNAL_ENTRY_KIND });
        const journalEntries =
          doc && doc.kind === JOURNAL_ENTRY_KIND ? [new JournalEntry(doc)] : [];
        return asText({ count: journalEntries.length, journalEntries });
      }
      // List mode: all live entries, optional substring query + limit.
      let docs = store.listDocuments({ kind: JOURNAL_ENTRY_KIND });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({
        count: docs.length,
        journalEntries: docs.map((d) => new JournalEntry(d)),
      });
    },
  );
}
