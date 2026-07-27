/**
 * The `Workstream` domain object — a PURE-DATA POCO reconstructed from a
 * Workstream document envelope.
 *
 * This file is a ROOT of the workstream folder's import graph: it imports
 * NOTHING from its siblings (only the store's `DocumentEnvelope` type), so the
 * tool files (`create` / `read` / `update` / `delete`) and `index.ts` can depend
 * on it without creating a cycle.
 *
 * `class Workstream` carries every field as a public instance property and
 * assigns them all in its constructor from a `DocumentEnvelope` — NO methods, NO
 * getters — so `JSON.stringify(new Workstream(env))` yields byte-for-byte the
 * same object the previous `mapWorkstream` projection returned (the `asText`
 * result is unchanged). Field declaration order AND constructor assignment order
 * both match the old object literal, so serialized key order is stable.
 *
 * The document↔domain mapping (unchanged from the old `mapWorkstream`):
 *   - `slug`       ← `metadata.slug`
 *   - `title`      ← `spec.title`
 *   - `status`     ← `spec.status`   (queue | progress | backlog | closed)
 *   - `closure`    ← `spec.closure`  (absent → null)
 *   - `opened_at`  ← `metadata.createdAt`
 *   - `updated_at` ← `metadata.updatedAt`
 *   - `closed_at`  ← derived: `metadata.updatedAt` when status is 'closed', else null
 *   - `id` / `resourceVersion` ← `metadata.*` (carried so callers can update)
 */

import type { DocumentEnvelope } from '../../store.js';

/**
 * The authored lifecycle status (a `spec` field), mirroring migration 014 and
 * the Workstream kind enum. Legacy 'open' is NOT part of this enum — it only
 * ever existed as a pre-migration DB value.
 */
export type WorkstreamLifecycleStatus = 'queue' | 'progress' | 'backlog' | 'closed';

/**
 * The legacy workstream shape, reconstructed from a Workstream document. This is
 * the interface `class Workstream` implements; the extension consumes an
 * equivalent shape through the client's `wsRead` / `wsCreate` / … (which owns its
 * own `Workstream` type).
 */
export interface IWorkstream {
  id: string;
  slug: string | null;
  title: string;
  status: WorkstreamLifecycleStatus;
  closure: string | null;
  opened_at: number;
  updated_at: number;
  closed_at: number | null;
  resourceVersion: number;
}

/**
 * A pure-data projection of a Workstream document envelope onto the legacy
 * workstream shape. The constructor holds the exact logic the old
 * `mapWorkstream` function used, so the two are interchangeable.
 */
export class Workstream implements IWorkstream {
  id: string;
  slug: string | null;
  title: string;
  status: WorkstreamLifecycleStatus;
  closure: string | null;
  opened_at: number;
  updated_at: number;
  closed_at: number | null;
  resourceVersion: number;

  constructor(env: DocumentEnvelope) {
    const spec = env.spec ?? {};
    const status = (spec.status as WorkstreamLifecycleStatus | undefined) ?? 'progress';
    const closure = typeof spec.closure === 'string' ? spec.closure : null;
    this.id = env.metadata.id;
    this.slug = env.metadata.slug;
    this.title = typeof spec.title === 'string' ? spec.title : '';
    this.status = status;
    this.closure = closure;
    this.opened_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    // The store has no closed_at column; best-effort is the last update time
    // when the workstream is in the terminal 'closed' state.
    this.closed_at = status === 'closed' ? env.metadata.updatedAt : null;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}
