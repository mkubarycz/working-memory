/**
 * The `JournalEntry` kind — mirrors the extension's `entries` table
 * (schema/001_initial.sql + schema/012_entries_created_by.sql) as a
 * control-plane document. Each journal entry is its OWN document
 * (entry-as-document): an authored, immutable-ish unit of the journal.
 *
 * Column → field placement (migrations 001 + 012):
 *   - `id`          → `metadata.id`  (the control-plane assigns its own uuid;
 *                      the extension's INTEGER PK is not carried over).
 *   - `timestamp`   → `metadata.createdAt`  (when the entry was authored).
 *   - `session_id`  → `spec.session`  (an OPTIONAL grouping ref — the session
 *                      the entry belongs to. Session is deferred as its own
 *                      kind; here it is just a ref string on the entry.)
 *   - `body`        → `spec.body`  (NOT NULL — the entry text; required).
 *   - `created_by`  → `spec.createdBy`  (NOT NULL DEFAULT 'system', migration
 *                      012 — who authored the entry).
 *
 * Refs are SPEC-EMBEDDED — there is NO edges table. An entry tags back to what
 * it references via spec:
 *   - `spec.workstream` — the owning workstream slug (required; every entry
 *      belongs to a workstream).
 *   - `spec.topics`     — topic slugs the entry references/tags. This FOLDS the
 *      extension's `entry_topics(entry_id, topic_slug)` join table
 *      (schema/003_topics.sql) into an array on the entry itself.
 *   - `spec.session`    — the optional session grouping ref (see above).
 *
 * No envelope `status` schema → inherits Base's empty `{}` status. An entry is
 * authored content, not controller-driven — nothing writes an envelope status
 * for it (same pattern as Topic / Workstream / Alert).
 *
 * Drop-in discovered by `loader.ts`; no registration list to edit.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { JournalEntry } from './journalentry.js';

/** The JournalEntry kind name in the control-plane registry. */
const JOURNAL_ENTRY_KIND = 'JournalEntry';

// Re-export the POCO interface so type consumers can import it from the kind
// entry point (mirrors the Workstream kind).
export type { IJournalEntry } from './journalentry.js';

const entry: KindModule = {
  name: JOURNAL_ENTRY_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // The entry text — mirrors `entries.body` (NOT NULL). Required.
        body: z.string().min(1),
        // Owning workstream slug — every entry belongs to a workstream. A
        // spec-embedded ref (no edges table). Required.
        workstream: z.string().min(1),
        // The session id the entry belongs to — mirrors `entries.session_id`.
        // Optional grouping ref; Session is deferred as its own kind.
        session: z.string().optional(),
        // Topic slugs the entry references/tags — folds the extension's
        // `entry_topics` join table into a spec array (no edges table).
        topics: z.array(z.string()).default([]),
        // Who authored the entry — mirrors `entries.created_by` (NOT NULL
        // DEFAULT 'system', migration 012).
        createdBy: z.string().default('system'),
      })
      .strict(),
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    fts: (r) => r.spec.body,
  },
  // The JournalEntry domain API (`ws-journalentry-*`) — schema + validation +
  // API co-located, mirroring the Topic/Workstream kinds.
  registerApi: registerJournalEntryApi,
};

/**
 * Register the JournalEntry domain API (`ws-journalentry-*`) on an MCP session's
 * server. Each tool speaks the legacy journal-entry shape and is backed by
 * generic `store` document ops for kind `JournalEntry`, with the kind's own
 * `validateSpec` gating writes. Entries have NO slug (the extension's PK is an
 * autoincrement integer → a control-plane uuid), so — unlike Workstream/Topic —
 * read/update/delete key on the document `id`.
 */
function registerJournalEntryApi(server: McpServer, store: Store): void {
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

export default entry;
