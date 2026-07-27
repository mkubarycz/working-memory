/**
 * `ws-journalentry-update` — the JournalEntry kind's Update tool.
 *
 * One of the four tool files in the `journalentry/` kind folder. Registered by
 * the folder's `index.ts` `registerApi` (which calls
 * {@link registerWsJournalEntryUpdate}); result helpers come from
 * `../toolResult.js` and the `JournalEntry` projection + kind name from
 * `./journalentry.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { JournalEntry, JOURNAL_ENTRY_KIND } from './journalentry.js';

/**
 * Register the `ws-journalentry-update` tool on an MCP session's server. Reads
 * the current document for its resourceVersion, merges the patch, re-validates
 * the whole spec against the JournalEntry kind, then does a compare-and-swap
 * write. Unknown id and version conflicts are surfaced clearly.
 */
export function registerWsJournalEntryUpdate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-journalentry-update',
    {
      title: 'JournalEntry: Update',
      description:
        'Update a JournalEntry identified by `id`. Pass only the fields you are changing (`body`, ' +
        '`workstream`, `session`, `topics`, `createdBy`). Reads the current document for its ' +
        'resourceVersion, then does a compare-and-swap write of the merged, re-validated spec. ' +
        'Unknown id and version conflicts are surfaced clearly. Returns the updated entry.',
      inputSchema: {
        id: z.string().describe('Document id of the entry to update (required).'),
        body: z.string().optional().describe('New entry text.'),
        workstream: z.string().optional().describe('New owning workstream slug.'),
        session: z.string().optional().describe('New session grouping ref.'),
        topics: z.array(z.string()).optional().describe('Replacement topic slugs.'),
        createdBy: z.string().optional().describe('New author.'),
      },
    },
    async ({ id, body, workstream, session, topics, createdBy }) => {
      const existing = store.getDocument({ id, kind: JOURNAL_ENTRY_KIND });
      if (!existing || existing.kind !== JOURNAL_ENTRY_KIND) {
        return asError(`Unknown entry id: "${id}". No live entry with that id.`);
      }
      const patch: Record<string, unknown> = {};
      if (body !== undefined) {
        patch.body = body;
      }
      if (workstream !== undefined) {
        patch.workstream = workstream;
      }
      if (session !== undefined) {
        patch.session = session;
      }
      if (topics !== undefined) {
        patch.topics = topics;
      }
      if (createdBy !== undefined) {
        patch.createdBy = createdBy;
      }
      if (Object.keys(patch).length === 0) {
        // Nothing to change: return the current mapped entry rather than a no-op
        // CAS write.
        return asText(new JournalEntry(existing));
      }
      let validatedSpec: Record<string, unknown>;
      try {
        // Merge the patch onto the current spec, then re-validate the whole spec.
        validatedSpec = validateSpec(JOURNAL_ENTRY_KIND, { ...existing.spec, ...patch });
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec: validatedSpec,
        });
        return asText(new JournalEntry(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: entry "${id}" changed since it was read (current resourceVersion ` +
              `${err.currentResourceVersion}). Re-read with ws-journalentry-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(`Unknown entry id: "${id}". It no longer exists (it may have been deleted).`);
        }
        throw err;
      }
    },
  );
}
