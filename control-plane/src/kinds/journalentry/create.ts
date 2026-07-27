/**
 * `ws-journalentry-create` — the JournalEntry kind's Create tool.
 *
 * One of the four tool files in the `journalentry/` kind folder. Registered by
 * the folder's `index.ts` `registerApi` (which calls
 * {@link registerWsJournalEntryCreate}); result helpers come from
 * `../toolResult.js` and the `JournalEntry` projection + kind name from
 * `./journalentry.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { JournalEntry, JOURNAL_ENTRY_KIND } from './journalentry.js';

/**
 * Register the `ws-journalentry-create` tool on an MCP session's server. The
 * tool speaks the legacy journal-entry shape and is backed by generic `store`
 * document ops for kind `JournalEntry`, with the kind's own `validateSpec`
 * gating the write. Entries have NO slug (the extension's PK is an autoincrement
 * integer → a control-plane uuid), so identity is the store-assigned
 * `metadata.id`.
 */
export function registerWsJournalEntryCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-journalentry-create',
    {
      title: 'JournalEntry: Create',
      description:
        'Create a JournalEntry. Provide a `body` (required) and its owning `workstream` slug ' +
        '(required); optionally a `session` grouping ref, a `topics` array of topic slugs, and ' +
        "`createdBy` (default 'system'). The spec is validated against the JournalEntry kind. " +
        'Returns the created entry.',
      inputSchema: {
        body: z.string().describe('The entry text (required).'),
        workstream: z.string().describe('Owning workstream slug (required).'),
        session: z.string().optional().describe('Optional session grouping ref.'),
        topics: z.array(z.string()).optional().describe('Topic slugs the entry references.'),
        createdBy: z.string().optional().describe("Who authored the entry (default 'system')."),
      },
    },
    async ({ body, workstream, session, topics, createdBy }) => {
      const specInput: Record<string, unknown> = { body, workstream };
      if (session !== undefined) {
        specInput.session = session;
      }
      if (topics !== undefined) {
        specInput.topics = topics;
      }
      if (createdBy !== undefined) {
        specInput.createdBy = createdBy;
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(JOURNAL_ENTRY_KIND, specInput);
        docStatus = defaultStatus(JOURNAL_ENTRY_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      // Entries have no slug — the store assigns the uuid `metadata.id` as identity.
      const doc = store.createDocument({
        kind: JOURNAL_ENTRY_KIND,
        spec: validatedSpec,
        status: docStatus,
      });
      return asText(new JournalEntry(doc));
    },
  );
}
