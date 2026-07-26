/**
 * Workstream DOMAIN LAYER (WM 13.0 "rehome-wm-tools").
 *
 * A thin translation shim that reimplements the legacy workstream operations
 * (`listWorkstreams` / `createWorkstream` / `updateWorkstream`) on top of the
 * NEW control-plane document store, using ONLY the four core CRUD tools via
 * {@link ControlPlaneClient}. It maps a `Workstream` DOCUMENT ↔ the legacy
 * workstream shape so the rest of the extension can eventually swap its backing
 * store without changing call sites.
 *
 * This module is the FIRST domain slice: it builds and proves the domain layer
 * only. It does NOT touch the live journal-backed tools, the panel, or the
 * Active tab — those keep talking to `JournalStore` until a later slice
 * repoints them.
 *
 * Field mapping (Workstream document envelope → DomainWorkstream), mirroring
 * `control-plane/src/kinds/workstream.kind.ts`:
 *   - `slug`       ← `metadata.slug`
 *   - `title`      ← `spec.title`
 *   - `status`     ← `spec.status`   (queue | progress | backlog | closed)
 *   - `closure`    ← `spec.closure`  (absent → null)
 *   - `opened_at`  ← `metadata.createdAt`
 *   - `updated_at` ← `metadata.updatedAt`
 *   - `closed_at`  ← derived: `metadata.updatedAt` when status is 'closed',
 *                    else null (the store has no dedicated closed_at column)
 *   - `id` / `resourceVersion` ← `metadata.*` (carried so callers can update)
 *
 * VS Code-free by construction: it takes a `ControlPlaneClient` and is unit-
 * tested against an ephemeral in-process control-plane server.
 */

import type {
  ControlPlaneClient,
  DocumentEnvelope,
} from '../controlPlaneClient';

/** The Workstream kind name in the control-plane registry. */
const WORKSTREAM_KIND = 'Workstream';

/**
 * The authored lifecycle status (a `spec` field), mirroring migration 014 and
 * the Workstream kind enum. The legacy 'open' alias is NOT part of the document
 * enum — it only ever existed as a pre-migration DB value.
 */
export type WorkstreamLifecycleStatus = 'queue' | 'progress' | 'backlog' | 'closed';

/**
 * The legacy workstream shape, reconstructed from a Workstream document. Mirrors
 * the fields of `db.ts::Workstream` that survive the round-trip; `id` and
 * `resourceVersion` are the document's (a uuid + CAS counter), not the legacy
 * integer rowid.
 */
export interface DomainWorkstream {
  /** Document id (uuid). Distinct from the legacy integer rowid. */
  id: string;
  slug: string | null;
  title: string;
  status: WorkstreamLifecycleStatus;
  closure: string | null;
  opened_at: number;
  updated_at: number;
  closed_at: number | null;
  /** CAS counter from the envelope, for a subsequent update. */
  resourceVersion: number;
}

export interface CreateWorkstreamInput {
  slug: string;
  title: string;
  status?: WorkstreamLifecycleStatus;
  closure?: string;
}

export interface UpdateWorkstreamInput {
  slug: string;
  title?: string;
  status?: WorkstreamLifecycleStatus;
  closure?: string;
}

/**
 * Thrown when a domain operation can't complete: the daemon is unreachable, the
 * target workstream is missing, or the control-plane rejected the write (spec
 * validation, version conflict, …). The underlying control-plane message is
 * preserved so conflicts/not-found surface clearly.
 */
export class WorkstreamDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkstreamDomainError';
  }
}

/** Map a Workstream document envelope to the legacy workstream shape. */
export function mapWorkstreamDocument(env: DocumentEnvelope): DomainWorkstream {
  const spec = env.spec ?? {};
  const status = (spec.status as WorkstreamLifecycleStatus | undefined) ?? 'progress';
  const closure = typeof spec.closure === 'string' ? spec.closure : null;
  return {
    id: env.metadata.id,
    slug: env.metadata.slug,
    title: typeof spec.title === 'string' ? spec.title : '',
    status,
    closure,
    opened_at: env.metadata.createdAt,
    updated_at: env.metadata.updatedAt,
    // The store has no closed_at column; the best-effort derivation is the last
    // update time when the workstream is in the terminal 'closed' state.
    closed_at: status === 'closed' ? env.metadata.updatedAt : null,
    resourceVersion: env.metadata.resourceVersion,
  };
}

/** List all Workstream documents mapped to the legacy shape. */
export async function listWorkstreams(
  client: ControlPlaneClient,
): Promise<DomainWorkstream[]> {
  const result = await client.listDocuments(WORKSTREAM_KIND);
  if (!result.available) {
    throw new WorkstreamDomainError(
      result.error ?? 'Control plane unavailable while listing workstreams',
    );
  }
  return result.documents.map(mapWorkstreamDocument);
}

/**
 * Create a Workstream document from the legacy create input. `status`/`closure`
 * are only sent when provided so the kind's defaults (status → 'progress')
 * apply otherwise.
 */
export async function createWorkstream(
  client: ControlPlaneClient,
  input: CreateWorkstreamInput,
): Promise<DomainWorkstream> {
  const spec: Record<string, unknown> = { title: input.title };
  if (input.status !== undefined) {
    spec.status = input.status;
  }
  if (input.closure !== undefined) {
    spec.closure = input.closure;
  }
  const result = await client.createDocument({
    kind: WORKSTREAM_KIND,
    slug: input.slug,
    spec,
  });
  if (!result.available) {
    throw new WorkstreamDomainError(
      result.error ?? 'Control plane unavailable while creating workstream',
    );
  }
  if (!result.document) {
    throw new WorkstreamDomainError(
      result.error ?? 'Control plane rejected the workstream create',
    );
  }
  return mapWorkstreamDocument(result.document);
}

/**
 * Update a Workstream document identified by `slug`. Reads the current document
 * to obtain its id + resourceVersion (for the CAS guard), sends ONLY the
 * changed spec fields, and returns the updated mapped workstream. Missing slug
 * and version conflicts surface as {@link WorkstreamDomainError}.
 */
export async function updateWorkstream(
  client: ControlPlaneClient,
  input: UpdateWorkstreamInput,
): Promise<DomainWorkstream> {
  const read = await client.getDocument({ slug: input.slug, kind: WORKSTREAM_KIND });
  if (!read.available) {
    throw new WorkstreamDomainError(
      read.error ?? 'Control plane unavailable while reading workstream',
    );
  }
  if (!read.document) {
    throw new WorkstreamDomainError(`workstream not found (slug=${input.slug})`);
  }

  const spec: Record<string, unknown> = {};
  if (input.title !== undefined) {
    spec.title = input.title;
  }
  if (input.status !== undefined) {
    spec.status = input.status;
  }
  if (input.closure !== undefined) {
    spec.closure = input.closure;
  }
  if (Object.keys(spec).length === 0) {
    // No spec change requested: return the current mapped document unchanged
    // rather than issuing a no-op update the control-plane would reject.
    return mapWorkstreamDocument(read.document);
  }

  const result = await client.updateDocument({
    id: read.document.metadata.id,
    expectedResourceVersion: read.document.metadata.resourceVersion,
    spec,
  });
  if (!result.available) {
    throw new WorkstreamDomainError(
      result.error ?? 'Control plane unavailable while updating workstream',
    );
  }
  if (!result.document) {
    throw new WorkstreamDomainError(
      result.error ?? 'Control plane rejected the workstream update',
    );
  }
  return mapWorkstreamDocument(result.document);
}

/**
 * Fetch one Workstream document by slug, mapped to the legacy shape. Returns
 * `null` when no live workstream has that slug; throws
 * {@link WorkstreamDomainError} only when the control-plane is unreachable.
 */
export async function getWorkstream(
  client: ControlPlaneClient,
  slug: string,
): Promise<DomainWorkstream | null> {
  const read = await client.getDocument({ slug, kind: WORKSTREAM_KIND });
  if (!read.available) {
    throw new WorkstreamDomainError(
      read.error ?? 'Control plane unavailable while reading workstream',
    );
  }
  return read.document ? mapWorkstreamDocument(read.document) : null;
}

/**
 * Soft-delete the Workstream document identified by `slug`. Reads the live
 * document to obtain its id + resourceVersion (CAS guard), then soft-deletes it.
 * Missing slug, version conflicts, and an unreachable daemon surface as
 * {@link WorkstreamDomainError}. Returns the mapped (now soft-deleted) shape.
 */
export async function deleteWorkstream(
  client: ControlPlaneClient,
  slug: string,
): Promise<DomainWorkstream> {
  const read = await client.getDocument({ slug, kind: WORKSTREAM_KIND });
  if (!read.available) {
    throw new WorkstreamDomainError(
      read.error ?? 'Control plane unavailable while reading workstream',
    );
  }
  if (!read.document) {
    throw new WorkstreamDomainError(`workstream not found (slug=${slug})`);
  }
  const result = await client.deleteDocument({
    id: read.document.metadata.id,
    expectedResourceVersion: read.document.metadata.resourceVersion,
  });
  if (!result.available) {
    throw new WorkstreamDomainError(
      result.error ?? 'Control plane unavailable while deleting workstream',
    );
  }
  if (!result.document) {
    throw new WorkstreamDomainError(
      result.error ?? 'Control plane rejected the workstream delete',
    );
  }
  return mapWorkstreamDocument(result.document);
}

/**
 * Undelete the soft-deleted Workstream document identified by `slug`. Restore is
 * by id, but callers only know the slug, so this reads with `includeDeleted` to
 * locate the id, then restores. Throws {@link WorkstreamDomainError} when no
 * soft-deleted workstream has that slug, when the control-plane rejects the
 * restore (e.g. the slug is already live), or when the daemon is unreachable.
 * Returns the mapped (now live) shape.
 */
export async function restoreWorkstream(
  client: ControlPlaneClient,
  slug: string,
): Promise<DomainWorkstream> {
  const read = await client.getDocument({
    slug,
    kind: WORKSTREAM_KIND,
    includeDeleted: true,
  });
  if (!read.available) {
    throw new WorkstreamDomainError(
      read.error ?? 'Control plane unavailable while reading workstream',
    );
  }
  if (!read.document) {
    throw new WorkstreamDomainError(`workstream not found (slug=${slug})`);
  }
  const result = await client.deleteDocument({
    id: read.document.metadata.id,
    restore: true,
  });
  if (!result.available) {
    throw new WorkstreamDomainError(
      result.error ?? 'Control plane unavailable while restoring workstream',
    );
  }
  if (!result.document) {
    throw new WorkstreamDomainError(
      result.error ?? 'Control plane rejected the workstream restore',
    );
  }
  return mapWorkstreamDocument(result.document);
}
