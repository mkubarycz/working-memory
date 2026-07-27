/**
 * `ws-alert-read` — the Alert kind's Read/List tool.
 *
 * One of the four tool files in the `alert/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsAlertRead});
 * result helpers come from `../toolResult.js` and the `Alert` projection + kind
 * name from `./alert.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { asText } from '../toolResult.js';
import { Alert, ALERT_KIND } from './alert.js';

/**
 * Register the `ws-alert-read` tool on an MCP session's server. Reads ONE alert
 * by id, or LISTs all live Alerts (optionally filtered), always returning the
 * uniform `{ count, alerts }` shape.
 */
export function registerWsAlertRead(server: McpServer, store: Store): void {
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
}
