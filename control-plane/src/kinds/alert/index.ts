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
 * No envelope `status` schema → inherits Base's empty `{}` status. The authored
 * `spec.status` above is distinct from the envelope status (which stays Base's
 * empty object), same disambiguation as Topic/Workstream.
 *
 * Drop-in discovered by `loader.ts`; no registration list to edit.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { Alert } from './alert.js';

/** The Alert kind name in the control-plane registry. */
const ALERT_KIND = 'Alert';

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
      })
      .strict(),
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    fts: (r) => `${r.spec.title}\n${r.spec.description}`,
  },
  // The Alert domain API (`ws-alert-*`) — schema + validation + API co-located,
  // mirroring the Topic/Workstream kinds.
  registerApi: registerAlertApi,
};

/**
 * Register the Alert domain API (`ws-alert-*`) on an MCP session's server. Each
 * tool speaks the legacy alert shape and is backed by generic `store` document
 * ops for kind `Alert`, with the kind's own `validateSpec` gating writes (so an
 * invalid status is rejected as kind validation, not a raw store error). Alerts
 * have NO slug (the extension's PK is an autoincrement integer → a control-plane
 * uuid), so — unlike Workstream/Topic — read/update/delete key on the document
 * `id`.
 */
function registerAlertApi(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-alert-create',
    {
      title: 'Alert: Create',
      description:
        'Create an Alert (a structured "needs attention" item). Provide a `description` (required) ' +
        'plus optional `title`, `recommended_action`, `status` (\'alert\' | \'informational\' | ' +
        "'closed', default 'alert'), `dedupe_key` (recurrence key), and `created_by` (default " +
        "'system'). The spec is validated against the Alert kind. Returns the created alert.",
      inputSchema: {
        title: z.string().optional().describe('Short friendly title (default empty).'),
        description: z.string().describe('The alert body/message (required).'),
        recommended_action: z.string().optional().describe('Suggested next step (default empty).'),
        status: z
          .string()
          .optional()
          .describe("Lifecycle status: 'alert' | 'informational' | 'closed' (default 'alert')."),
        dedupe_key: z.string().optional().describe('Optional recurrence/dedupe key.'),
        created_by: z.string().optional().describe("Who raised it (default 'system')."),
      },
    },
    async ({ title, description, recommended_action, status, dedupe_key, created_by }) => {
      const specInput: Record<string, unknown> = { description };
      if (title !== undefined) {
        specInput.title = title;
      }
      if (recommended_action !== undefined) {
        specInput.recommended_action = recommended_action;
      }
      if (status !== undefined) {
        specInput.status = status;
      }
      if (dedupe_key !== undefined) {
        specInput.dedupe_key = dedupe_key;
      }
      if (created_by !== undefined) {
        specInput.created_by = created_by;
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(ALERT_KIND, specInput);
        docStatus = defaultStatus(ALERT_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      // Alerts have no slug — the store assigns the uuid `metadata.id` as identity.
      const doc = store.createDocument({ kind: ALERT_KIND, spec: validatedSpec, status: docStatus });
      return asText(new Alert(doc));
    },
  );

  server.registerTool(
    'ws-alert-read',
    {
      title: 'Alert: Read',
      description:
        'Read one Alert or many. Read ONE by `id`; otherwise LIST all Alerts (newest-first), with ' +
        'an optional `query` case-insensitive substring filter and a `limit`. ALWAYS returns ' +
        '{ count, alerts } — a by-id read yields a 0-or-1 element list, so callers get one uniform ' +
        'shape.',
      inputSchema: {
        id: z.string().optional().describe('Read ONE alert by document id (uuid).'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter over alert text (list mode only).'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max alerts to return (list mode only).'),
      },
    },
    async ({ id, query, limit }) => {
      // Single read: by id (foreign-kind id maps to nothing — the id lookup is
      // kind-agnostic in the store, so guard the kind here).
      if (id !== undefined) {
        const doc = store.getDocument({ id, kind: ALERT_KIND });
        const alerts = doc && doc.kind === ALERT_KIND ? [new Alert(doc)] : [];
        return asText({ count: alerts.length, alerts });
      }
      // List mode: all live Alerts, optional substring query + limit.
      let docs = store.listDocuments({ kind: ALERT_KIND });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, alerts: docs.map((d) => new Alert(d)) });
    },
  );

  server.registerTool(
    'ws-alert-update',
    {
      title: 'Alert: Update',
      description:
        'Update an Alert identified by `id`. Pass only the fields you are changing (`title`, ' +
        '`description`, `recommended_action`, `status`, `dedupe_key`, `created_by`). Reads the ' +
        'current document for its resourceVersion, then does a compare-and-swap write of the ' +
        'merged, re-validated spec. Unknown id and version conflicts are surfaced clearly. Returns ' +
        'the updated alert.',
      inputSchema: {
        id: z.string().describe('Document id of the alert to update (required).'),
        title: z.string().optional().describe('New title.'),
        description: z.string().optional().describe('New description.'),
        recommended_action: z.string().optional().describe('New recommended action.'),
        status: z
          .string()
          .optional()
          .describe("New status: 'alert' | 'informational' | 'closed'."),
        dedupe_key: z.string().optional().describe('New dedupe key.'),
        created_by: z.string().optional().describe('New author.'),
      },
    },
    async ({ id, title, description, recommended_action, status, dedupe_key, created_by }) => {
      const existing = store.getDocument({ id, kind: ALERT_KIND });
      if (!existing || existing.kind !== ALERT_KIND) {
        return asError(`Unknown alert id: "${id}". No live alert with that id.`);
      }
      const patch: Record<string, unknown> = {};
      if (title !== undefined) {
        patch.title = title;
      }
      if (description !== undefined) {
        patch.description = description;
      }
      if (recommended_action !== undefined) {
        patch.recommended_action = recommended_action;
      }
      if (status !== undefined) {
        patch.status = status;
      }
      if (dedupe_key !== undefined) {
        patch.dedupe_key = dedupe_key;
      }
      if (created_by !== undefined) {
        patch.created_by = created_by;
      }
      if (Object.keys(patch).length === 0) {
        // Nothing to change: return the current mapped alert rather than a no-op
        // CAS write.
        return asText(new Alert(existing));
      }
      let validatedSpec: Record<string, unknown>;
      try {
        // Merge the patch onto the current spec, then re-validate the whole spec.
        validatedSpec = validateSpec(ALERT_KIND, { ...existing.spec, ...patch });
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec: validatedSpec,
        });
        return asText(new Alert(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: alert "${id}" changed since it was read (current resourceVersion ` +
              `${err.currentResourceVersion}). Re-read with ws-alert-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(`Unknown alert id: "${id}". It no longer exists (it may have been deleted).`);
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'ws-alert-delete',
    {
      title: 'Alert: Delete',
      description:
        'Soft-delete an Alert by `id` (it drops out of ws-alert-read). To undelete, call with ' +
        '`restore: true`. Unknown/already-deleted id (or an already-live id on restore) is ' +
        'rejected. Returns { ok, id }.',
      inputSchema: {
        id: z.string().describe('Document id of the alert to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted alert instead of deleting.'),
      },
    },
    async ({ id, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({ id, kind: ALERT_KIND, includeDeleted: restore === true });
      if (!doc || doc.kind !== ALERT_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted alert with id "${id}" to restore.`
            : `Unknown alert id: "${id}". No live alert with that id.`,
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
              ? `No soft-deleted alert with id "${id}" to restore.`
              : `Unknown or already-deleted alert id: "${id}".`,
          );
        }
        throw err;
      }
    },
  );
}

export default alert;
