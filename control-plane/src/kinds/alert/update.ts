/**
 * `ws-alert-update` — the Alert kind's Update tool.
 *
 * One of the four tool files in the `alert/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsAlertUpdate});
 * result helpers come from `../toolResult.js` and the `Alert` projection + kind
 * name from `./alert.js`.
 *
 * NOTE: `spec.topics` is an ordinary spec field, so this one Update tool fully
 * edits an alert's topic references — there are no bespoke link tools.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { Alert, ALERT_KIND } from './alert.js';

/**
 * Register the `ws-alert-update` tool on an MCP session's server. Reads the
 * current document for its resourceVersion, merges the patch, re-validates the
 * whole spec against the Alert kind, then does a compare-and-swap write. Unknown
 * id and version conflicts are surfaced clearly.
 */
export function registerWsAlertUpdate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-alert-update',
    {
      title: 'Alert: Update',
      description:
        'Update an Alert identified by `id`. Pass only the fields you are changing (`title`, ' +
        '`description`, `recommended_action`, `status`, `dedupe_key`, `created_by`, `topics`). ' +
        'Reads the current document for its resourceVersion, then does a compare-and-swap write of ' +
        'the merged, re-validated spec. Unknown id and version conflicts are surfaced clearly. ' +
        'Returns the updated alert.',
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
        topics: z.array(z.string()).optional().describe('Replacement topic slugs.'),
      },
    },
    async ({ id, title, description, recommended_action, status, dedupe_key, created_by, topics }) => {
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
      if (topics !== undefined) {
        patch.topics = topics;
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
}
