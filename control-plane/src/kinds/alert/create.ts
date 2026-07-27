/**
 * `ws-alert-create` — the Alert kind's Create tool.
 *
 * One of the four tool files in the `alert/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsAlertCreate});
 * result helpers come from `../toolResult.js` and the `Alert` projection + kind
 * name from `./alert.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { Alert, ALERT_KIND } from './alert.js';

/**
 * Register the `ws-alert-create` tool on an MCP session's server. The tool
 * speaks the legacy alert shape and is backed by generic `store` document ops
 * for kind `Alert`, with the kind's own `validateSpec` gating the write. Alerts
 * have NO slug (the extension's PK is an autoincrement integer → a control-plane
 * uuid), so identity is the store-assigned `metadata.id`.
 */
export function registerWsAlertCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-alert-create',
    {
      title: 'Alert: Create',
      description:
        'Create an Alert (a structured "needs attention" item). Provide a `description` (required) ' +
        'plus optional `title`, `recommended_action`, `status` (\'alert\' | \'informational\' | ' +
        "'closed', default 'alert'), `dedupe_key` (recurrence key), `created_by` (default " +
        "'system'), and `topics` (topic-slug references). The spec is validated against the Alert " +
        'kind. Returns the created alert.',
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
        topics: z.array(z.string()).optional().describe('Topic slugs the alert references.'),
      },
    },
    async ({ title, description, recommended_action, status, dedupe_key, created_by, topics }) => {
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
      if (topics !== undefined) {
        specInput.topics = topics;
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
}
