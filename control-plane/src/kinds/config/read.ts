/**
 * `ws-config-read` — the Config kind's Read/List tool.
 *
 * One of the four tool files in the `config/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsConfigRead});
 * result helpers come from `../toolResult.js` and the `Config` projection +
 * kind name from `./config.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { asText } from '../toolResult.js';
import { Config, CONFIG_KIND } from './config.js';

/**
 * Register the `ws-config-read` tool on an MCP session's server. Reads ONE
 * config by slug/id, or LISTs all live Configs (optionally filtered), always
 * returning the uniform `{ count, configs }` shape.
 */
export function registerWsConfigRead(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-config-read',
    {
      title: 'Config: Read',
      description:
        'Read one Config or many. Read ONE by `slug` or `id`; otherwise LIST all Configs ' +
        '(newest-first), with an optional `query` case-insensitive substring filter and a `limit`. ' +
        'ALWAYS returns { count, configs } — a by-slug/id read yields a 0-or-1 element list, so ' +
        'callers get one uniform shape.',
      inputSchema: {
        slug: z.string().optional().describe('Read ONE config by slug (registry key).'),
        id: z.string().optional().describe('Read ONE config by document id (uuid).'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter over config text (list mode only).'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max configs to return (list mode only).'),
      },
    },
    async ({ slug, id, query, limit }) => {
      // Single read: by id or slug. A foreign-kind id maps to nothing (the
      // `ws-config-*` API only speaks Configs).
      if (id !== undefined || slug !== undefined) {
        const doc = store.getDocument({ id, slug, kind: CONFIG_KIND });
        const configs = doc && doc.kind === CONFIG_KIND ? [new Config(doc)] : [];
        return asText({ count: configs.length, configs });
      }
      // List mode: all live Configs, optional substring query + limit.
      let docs = store.listDocuments({ kind: CONFIG_KIND });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, configs: docs.map((d) => new Config(d)) });
    },
  );
}
