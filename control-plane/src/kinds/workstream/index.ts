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
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { WORKSTREAM_KIND } from './shared.js';
import { registerWsWorkstreamCreate } from './create.js';
import { registerWsWorkstreamRead } from './read.js';
import { registerWsWorkstreamUpdate } from './update.js';
import { registerWsWorkstreamDelete } from './delete.js';

// Re-export the domain type + POCO interface so type consumers of the kind can
// import them from the kind entry point (e.g. the default import in
// control-plane/tests/kinds.workstream.test.ts).
export type { IWorkstream, WorkstreamLifecycleStatus } from './workstream.js';

const workstream: KindModule = {
  name: WORKSTREAM_KIND,
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
  // The Workstream domain API (`ws-workstream-*`) — the four tools live in sibling
  // `create` / `read` / `update` / `delete` files; `registerApi` wires them together.
  registerApi: registerWorkstreamApi,
};

/**
 * Register the Workstream domain API (`ws-workstream-*`) on an MCP session's
 * server by wiring the four split tool files. Each tool lives in its own sibling
 * file (`create` / `read` / `update` / `delete`) in this kind folder and shares
 * the kind name + result helpers via `./shared.js` and the `Workstream`
 * projection via `./workstream.js`. This is the "kind is a plugin" surface:
 * schema + validation + the `ws-workstream-*` API all belong to this one kind —
 * just split across files in one folder.
 */
function registerWorkstreamApi(server: McpServer, store: Store): void {
  registerWsWorkstreamCreate(server, store);
  registerWsWorkstreamRead(server, store);
  registerWsWorkstreamUpdate(server, store);
  registerWsWorkstreamDelete(server, store);
}

export default workstream;
