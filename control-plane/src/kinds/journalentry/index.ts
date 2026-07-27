/**
 * The `JournalEntry` kind — mirrors the extension's `entries` table
 * (schema/001_initial.sql + schema/012_entries_created_by.sql) as a
 * control-plane document. Journal entries are the append-only beats logged
 * under a workstream (optionally grouped by session, optionally tagged to
 * topics).
 *
 * Column → field placement (migrations 001 + 012, refs folded into spec):
 *   - `id`         → `metadata.id`  (INTEGER PK AUTOINCREMENT in the extension →
 *                     a control-plane uuid; entries have NO string key, so there
 *                     is NO `metadata.slug` mapping)
 *   - `created_at` → `metadata.createdAt`
 *   - `updated_at` → `metadata` timestamp
 *   - `body`       → spec (authored, NOT NULL — the entry text)
 *   - `workstream` → spec (authored, NOT NULL — owning workstream slug ref)
 *   - `session`    → spec (authored, nullable — optional session grouping ref)
 *   - `topics`     → spec (topic-slug references — an ordinary array field, so
 *                     `ws-journalentry-update` edits it like any other spec
 *                     field; no edges table)
 *   - `created_by` → spec (authored, NOT NULL DEFAULT 'system', migration 012)
 *
 * No envelope `status` schema → inherits Base's empty `{}` status. Entries are
 * authored beats, not controller-driven — nothing writes an envelope status.
 *
 * Like the Workstream kind, JournalEntry self-registers its own namespaced
 * domain API (`ws-journalentry-*`) via `registerApi` — the four tools live in
 * sibling `create` / `read` / `update` / `delete` files; `registerApi` wires
 * them together.
 *
 * Drop-in discovered by `loader.ts`; no registration list to edit.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { JOURNAL_ENTRY_KIND } from './journalentry.js';
import { registerWsJournalEntryCreate } from './create.js';
import { registerWsJournalEntryRead } from './read.js';
import { registerWsJournalEntryUpdate } from './update.js';
import { registerWsJournalEntryDelete } from './delete.js';

// Re-export the POCO interface so type consumers can import it from the kind
// entry point (mirrors the Workstream kind).
export type { IJournalEntry } from './journalentry.js';

const journalEntry: KindModule = {
  name: JOURNAL_ENTRY_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // `body` — NOT NULL in migration 001; the entry text.
        body: z.string().min(1),
        // `workstream` — NOT NULL in migration 001; owning workstream slug ref.
        workstream: z.string().min(1),
        // `session` — nullable in migration 001; optional session grouping ref.
        session: z.string().optional(),
        // Topic-slug references the entry points at — a spec-embedded ref (no
        // edges table), so `ws-journalentry-update` edits it like any other
        // spec field.
        topics: z.array(z.string()).default([]),
        // `created_by` — NOT NULL DEFAULT 'system' (migration 012).
        createdBy: z.string().default('system'),
      })
      .strict(),
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    fts: (r) => `${r.spec.body}`,
  },
  // The JournalEntry domain API (`ws-journalentry-*`) — the four tools live in
  // sibling `create` / `read` / `update` / `delete` files; `registerApi` wires
  // them together.
  registerApi: registerJournalEntryApi,
};

/**
 * Register the JournalEntry domain API (`ws-journalentry-*`) on an MCP
 * session's server by wiring the four split tool files. Each tool lives in its
 * own sibling file (`create` / `read` / `update` / `delete`) in this kind
 * folder and shares the kind name + `JournalEntry` projection via
 * `./journalentry.js` and the result helpers via `../toolResult.js`. Entries
 * have NO slug (the extension's PK is an autoincrement integer → a
 * control-plane uuid), so read/update/delete key on the document `id`. Mirrors
 * the Workstream kind exactly.
 */
function registerJournalEntryApi(server: McpServer, store: Store): void {
  registerWsJournalEntryCreate(server, store);
  registerWsJournalEntryRead(server, store);
  registerWsJournalEntryUpdate(server, store);
  registerWsJournalEntryDelete(server, store);
}

export default journalEntry;
