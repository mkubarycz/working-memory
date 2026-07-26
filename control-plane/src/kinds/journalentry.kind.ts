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
import { Base, type KindModule } from './base.js';

const entry: KindModule = {
  name: 'JournalEntry',
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
};

export default entry;
