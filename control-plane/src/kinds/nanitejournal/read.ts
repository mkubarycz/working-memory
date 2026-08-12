/**
 * `ws-nanitejournal-read` — the NaniteJournal kind's Read/List tool.
 *
 * Read ONE record by `id`, or LIST a nanite's run history by `naniteId`
 * (newest-first — the panel/chat shows the most recent run first), or LIST all
 * live journals. Always returns the uniform `{ count, journals }` shape.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { asText } from '../toolResult.js';
import { NaniteJournal, NANITE_JOURNAL_KIND } from './naniteJournal.js';

/** Register the `ws-nanitejournal-read` tool. */
export function registerWsNaniteJournalRead(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanitejournal-read',
    {
      title: 'Nanite Journal: Read',
      description:
        'Read one NaniteJournal record or many. Read ONE by `id`; filter by `naniteId` to list a ' +
        "single nanite's run history (newest-first); otherwise LIST all journals. An optional " +
        '`limit` caps list results. ALWAYS returns { count, journals } — a by-id read yields a ' +
        '0-or-1 element list, so callers get one uniform shape.',
      inputSchema: {
        id: z.string().optional().describe('Read ONE journal by document id (uuid).'),
        naniteId: z
          .string()
          .optional()
          .describe("List a single nanite's run history (its document id)."),
        limit: z.number().int().positive().optional().describe('Max journals to return (list mode).'),
      },
    },
    async ({ id, naniteId, limit }) => {
      if (id !== undefined) {
        const doc = store.getDocument({ id, kind: NANITE_JOURNAL_KIND });
        const journals = doc && doc.kind === NANITE_JOURNAL_KIND ? [new NaniteJournal(doc)] : [];
        return asText({ count: journals.length, journals });
      }
      let docs = store.listDocuments({ kind: NANITE_JOURNAL_KIND });
      if (naniteId !== undefined) {
        docs = docs.filter((d) => d.spec?.naniteId === naniteId);
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, journals: docs.map((d) => new NaniteJournal(d)) });
    },
  );
}
