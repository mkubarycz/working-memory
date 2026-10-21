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
import { asText, asError } from '../toolResult.js';
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
        'shape. Deprecated adapter: list responses additionally report incompatibleMessageIds and warnings ' +
        'for canonical categories/lifecycles that cannot be represented, without hiding the incompatibility or failing compatible entries. ' +
        'An incompatible by-id read is an explicit error. Resolved request/completion history projects to closed without changing canonical category.',
      inputSchema: z.object({
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
      }).strict(),
    },
    async ({ id, query, limit }) => {
      // Single read: by id (foreign-kind id maps to nothing — the id lookup is
      // kind-agnostic in the store, so guard the kind here).
      if (id !== undefined) {
        const doc = store.getDocument({ id, kind: ALERT_KIND });
        try {
          const alerts = doc && doc.kind === 'AgentMessage' ? [new Alert(doc)] : [];
          return asText({ count: alerts.length, alerts });
        } catch (error) { return asError((error as Error).message); }
      }
      // List mode: all live Alerts, optional substring query + limit.
      let docs = store.listDocuments({ kind: ALERT_KIND });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
      }
      let alerts: Alert[] = [];
      const warnings: Array<{ id: string; message: string }> = [];
      for (const doc of docs) {
        try { alerts.push(new Alert(doc)); }
        catch (error) { warnings.push({ id: doc.metadata.id, message: (error as Error).message }); }
      }
      if (limit !== undefined) alerts = alerts.slice(0, limit);
      return asText({
        count: alerts.length, alerts,
        incompatibleMessageIds: warnings.map(({ id }) => id), warnings,
      });
    },
  );
}
