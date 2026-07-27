/**
 * The `JournalEntry` domain object — a PURE-DATA POCO reconstructed from a
 * JournalEntry document envelope.
 *
 * This file is a ROOT of the journalentry folder's import graph: it imports
 * NOTHING from its siblings (only the store's `DocumentEnvelope` type), so
 * `index.ts` can depend on it without creating a cycle.
 *
 * `class JournalEntry` carries every field as a public instance property
 * assigned in its constructor from a `DocumentEnvelope` — NO methods, NO
 * getters — so `JSON.stringify(new JournalEntry(env))` is a stable projection of
 * the document.
 *
 * The document↔domain mapping (mirrors migrations 001 + 012, refs folded into spec):
 *   - `id`              ← `metadata.id`   (the control-plane uuid; the
 *                          extension's INTEGER PK is not carried over — entries
 *                          have NO slug, so `slug` is always null)
 *   - `body`            ← `spec.body`
 *   - `workstream`      ← `spec.workstream` (owning workstream slug)
 *   - `session`         ← `spec.session` (optional grouping ref; absent → null)
 *   - `topics`          ← `spec.topics` (topic slugs; absent → [])
 *   - `createdBy`       ← `spec.createdBy` (absent → 'system')
 *   - `created_at`      ← `metadata.createdAt`
 *   - `updated_at`      ← `metadata.updatedAt`
 *   - `resourceVersion` ← `metadata.resourceVersion` (carried so callers can update)
 */

import type { DocumentEnvelope } from '../../store.js';

/** The JournalEntry kind name in the control-plane registry. */
export const JOURNAL_ENTRY_KIND = 'JournalEntry';

/**
 * The legacy journal-entry shape, reconstructed from a JournalEntry document.
 * This is the interface `class JournalEntry` implements.
 */
export interface IJournalEntry {
  id: string;
  slug: string | null;
  body: string;
  workstream: string;
  session: string | null;
  topics: string[];
  createdBy: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

/** Read a `string[]` spec field defensively (absent / foreign shape → `[]`). */
function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * A pure-data projection of a JournalEntry document envelope onto the legacy
 * journal-entry shape.
 */
export class JournalEntry implements IJournalEntry {
  id: string;
  slug: string | null;
  body: string;
  workstream: string;
  session: string | null;
  topics: string[];
  createdBy: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;

  constructor(env: DocumentEnvelope) {
    const spec = env.spec ?? {};
    this.id = env.metadata.id;
    this.slug = env.metadata.slug;
    this.body = typeof spec.body === 'string' ? spec.body : '';
    this.workstream = typeof spec.workstream === 'string' ? spec.workstream : '';
    this.session = typeof spec.session === 'string' ? spec.session : null;
    this.topics = stringArray(spec.topics);
    this.createdBy = typeof spec.createdBy === 'string' ? spec.createdBy : 'system';
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}
