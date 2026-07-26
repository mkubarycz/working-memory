/**
 * The `Workstream` kind — mirrors the extension's existing workstreams
 * (slug + title + lifecycle status + closure note) as a control-plane document.
 *
 * Mirrors `schema/001_initial.sql` (the `workstreams` table) as amended by
 * `schema/014_workstream_lifecycle_status.sql` (status becomes the lifecycle
 * enum `queue | progress | backlog | closed`, legacy 'open' → 'progress') and
 * `schema/015_workstream_updated_at.sql` (adds updated_at).
 *
 * Field placement — these table columns are ENVELOPE metadata, not spec:
 *   - `slug`       → `metadata.slug`
 *   - `opened_at`  → `metadata.createdAt`
 *   - `closed_at` / `updated_at` → `metadata` timestamps
 * So `spec` below is only the authored/domain fields (title, status, closure).
 * Workstreams have NO body — none is added here.
 *
 * Drop-in discovered by `loader.ts`; no registration list to edit.
 *
 * NOTE on the two "status" concepts (they are DISTINCT — same pattern as Topic):
 *   - `spec.status` (below) is the AUTHORED lifecycle field
 *     (queue|progress|backlog|closed) — human/agent input, part of desired
 *     state. It mirrors the existing workstreams.status column, so it keeps the
 *     name `status`.
 *   - The envelope `status` (controller-owned, observed state) is intentionally
 *     OMITTED, so Workstream inherits Base's empty `{}` status. Workstream is
 *     authored content, not controller-driven — nothing writes an envelope
 *     status for it.
 */

import { z } from 'zod';
import { Base, type KindModule } from './base.js';

const workstream: KindModule = {
  name: 'Workstream',
  descriptor: {
    extends: Base,
    spec: z
      .object({
        title: z.string().min(1).max(120),
        // AUTHORED lifecycle — a SPEC field, NOT the controller-owned envelope
        // status (which Workstream inherits empty from Base). Enum values mirror
        // migration 014 exactly; default 'progress' matches the app-code default
        // (createWorkstream in src/db.ts) and where legacy 'open' rows migrate.
        status: z.enum(['queue', 'progress', 'backlog', 'closed']).default('progress'),
        // The closure note, set when the workstream is closed (mirrors the
        // `closure` column). Optional — absent while the workstream is active.
        closure: z.string().optional(),
      })
      .strict(),
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    fts: (r) => (r.spec.closure ? `${r.spec.title}\n${r.spec.closure}` : r.spec.title),
  },
};

export default workstream;
