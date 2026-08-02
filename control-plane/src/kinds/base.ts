/**
 * The `Base` kind descriptor + shared kind-system types.
 *
 * A *kind* is a free-form string PLUS a registered descriptor in code. The
 * descriptor supplies a Zod `spec` schema (human/agent-authored desired state),
 * an OPTIONAL Zod `status` schema (controller-written observed state — omitted
 * means "inherit Base"), and an optional `fts` projection (row → search text).
 * There is **zero DDL per kind**: everything is validated + projected in code
 * over the single unified `resources` table.
 *
 * Every kind `extends` a single `Base` descriptor via Zod schema composition,
 * kept deliberately **shallow** (one Base; no deep chains). Base owns the
 * envelope everyone shares — `metadata` (id, slug, labels, timestamps,
 * resourceVersion) — and the lifecycle already baked into the base model
 * (not-created → created → deleted, all metadata-derived). Because that
 * lifecycle lives in metadata, Base's `status` is empty: kinds that aren't
 * controller-driven (Topic, Workstream, Entry, …) inherit it and store `{}`.
 */

import { z, type ZodTypeAny } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../store.js';

/** The row shape handed to a descriptor's `fts` projection. */
export interface FtsRow {
  kind: string;
  metadata: Record<string, unknown>;
  // `spec`/`status` are intentionally loose so kind files can write
  // `r.spec.title` without casts; validation already guarantees the shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  spec: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  status: any;
}

/**
 * A kind descriptor. `spec` is required; `status` is OPTIONAL (second-class) —
 * omit it to inherit Base's empty/lifecycle status. `fts` is the (deferred)
 * projection from a stored row to searchable text.
 */
export interface KindDescriptor {
  /** Parent descriptor to compose on top of. Defaults to `Base` when omitted. */
  extends?: KindDescriptor;
  /** Desired-state schema (authored input). Required. */
  spec: ZodTypeAny;
  /** Observed-state schema (controller output). Omit → inherit Base. */
  status?: ZodTypeAny;
  /** Projection to FTS text (wired in a later slice). */
  fts?: (row: FtsRow) => string;
  /** Validate envelope metadata before a document is created or updated. */
  validateMetadata?: (input: {
    slug: string | null | undefined;
    store: Store;
    excludeId?: string;
  }) => void;
}

/** What a `*.kind.ts` file default-exports; the loader registers these. */
export interface KindModule {
  name: string;
  descriptor: KindDescriptor;
  /**
   * OPTIONAL: register this kind's own **namespaced domain API** (MCP tools) on
   * the control-plane server, co-located with the schema. Called once per MCP
   * session by `createMcpServer` after the generic CRUD tools, for every
   * registered kind that defines it. A kind that omits this hook contributes
   * only the generic `wm-document-*` surface. Each kind owns a prefix namespace
   * (Workstream → `ws-`, …) and backs its tools with `store` document ops.
   */
  registerApi?(server: McpServer, store: Store): void;
}

/**
 * The root descriptor every kind extends. Its `spec` is empty (kinds add their
 * own fields), and its `status` is an empty object that defaults to `{}` — the
 * lifecycle itself is metadata-derived, not stored in status.
 */
export const Base: KindDescriptor = {
  spec: z.object({}),
  status: z.object({}).default({}),
};
