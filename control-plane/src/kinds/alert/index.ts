/**
 * The `Alert` kind — mirrors the extension's `alerts` table
 * (schema/016_alerts.sql + schema/017_alert_title.sql) as a control-plane
 * document. Alerts are structured "needs attention" items raised by agents or
 * background tasks.
 *
 * Column → field placement (migrations 016 + 017):
 *   - `id`                 → `metadata.id`  (INTEGER PK AUTOINCREMENT — NOT a
 *                             string key, so there is NO `metadata.slug`
 *                             mapping; the control-plane assigns its own uuid
 *                             `metadata.id`). The nearest human string key is
 *                             `dedupe_key`, kept in spec below.
 *   - `created_at`         → `metadata.createdAt`
 *   - `updated_at`         → `metadata` timestamp
 *   - `title`              → spec (authored, NOT NULL DEFAULT '' — friendly
 *                             short title, migration 017)
 *   - `description`        → spec (authored, NOT NULL — the alert body/message)
 *   - `recommended_action` → spec (authored, NOT NULL DEFAULT '')
 *   - `status`             → spec (authored lifecycle enum, NOT NULL DEFAULT
 *                             'alert', CHECK IN ('alert','informational',
 *                             'closed') — mirrors migration 016. Same pattern as
 *                             Topic/Workstream: an AUTHORED status field, NOT the
 *                             controller-owned envelope status. NOTE: there is no
 *                             controller path yet; if a controller later owns the
 *                             lifecycle, this may move to envelope status.)
 *   - `dedupe_key`         → spec (authored, nullable — the recurrence key)
 *   - `created_by`         → spec (authored, NOT NULL DEFAULT 'system' — who
 *                             raised it)
 *
 * Plus a spec-embedded ref (no edges table):
 *   - `topics`             → spec (topic-slug references the alert points at —
 *                             an ordinary array field, so `ws-alert-update`
 *                             edits it like any other spec field)
 *
 * No envelope `status` schema → inherits Base's empty `{}` status. The authored
 * `spec.status` above is distinct from the envelope status (which stays Base's
 * empty object), same disambiguation as Topic/Workstream.
 *
 * Like the Workstream kind, Alert self-registers its own namespaced domain API
 * (`ws-alert-*`) via `registerApi` — the four tools live in sibling
 * `create` / `read` / `update` / `delete` files; `registerApi` wires them together.
 *
 * Drop-in discovered by `loader.ts`; no registration list to edit.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { ALERT_KIND } from './alert.js';
import { registerWsAlertCreate } from './create.js';
import { registerWsAlertRead } from './read.js';
import { registerWsAlertUpdate } from './update.js';
import { registerWsAlertDelete } from './delete.js';

// Re-export the POCO interface + status type so type consumers can import them
// from the kind entry point (mirrors the Workstream kind).
export type { IAlert, AlertStatus } from './alert.js';

const alert: KindModule = {
  name: ALERT_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // `title` — NOT NULL DEFAULT '' (migration 017).
        title: z.string().default(''),
        // `description` — NOT NULL (migration 016); the alert body/message.
        description: z.string().min(1),
        // `recommended_action` — NOT NULL DEFAULT '' (migration 016).
        recommended_action: z.string().default(''),
        // AUTHORED lifecycle — a SPEC field, NOT the controller-owned envelope
        // status (which Alert inherits empty from Base). Enum + default mirror
        // migration 016's CHECK constraint and DEFAULT exactly.
        status: z.enum(['alert', 'informational', 'closed']).default('alert'),
        // `dedupe_key` — nullable in migration 016; optional here.
        dedupe_key: z.string().optional(),
        // `created_by` — NOT NULL DEFAULT 'system' (migration 016).
        created_by: z.string().default('system'),
        // Topic-slug references the alert points at — a spec-embedded ref (no
        // edges table), so `ws-alert-update` edits it like any other spec field.
        topics: z.array(z.string()).default([]),
      })
      .strict(),
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    fts: (r) => `${r.spec.title}\n${r.spec.description}`,
  },
  // The Alert domain API (`ws-alert-*`) — the four tools live in sibling
  // `create` / `read` / `update` / `delete` files; `registerApi` wires them together.
  registerApi: registerAlertApi,
};

/**
 * Register the Alert domain API (`ws-alert-*`) on an MCP session's server by
 * wiring the four split tool files. Each tool lives in its own sibling file
 * (`create` / `read` / `update` / `delete`) in this kind folder and shares the
 * kind name + `Alert` projection via `./alert.js` and the result helpers via
 * `../toolResult.js`. Alerts have NO slug (the extension's PK is an
 * autoincrement integer → a control-plane uuid), so read/update/delete key on
 * the document `id`. Mirrors the Workstream kind exactly.
 */
function registerAlertApi(server: McpServer, store: Store): void {
  registerWsAlertCreate(server, store);
  registerWsAlertRead(server, store);
  registerWsAlertUpdate(server, store);
  registerWsAlertDelete(server, store);
}

export default alert;
