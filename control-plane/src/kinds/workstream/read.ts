/**
 * `ws-workstream-read` — the Workstream kind's Read/List tool.
 *
 * One of the four tool files in the `workstream/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsWorkstreamRead});
 * shared helpers come from `./shared.js` and the `Workstream` projection from
 * `./workstream.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { WORKSTREAM_KIND, asText } from './shared.js';
import { Workstream } from './workstream.js';

/**
 * Register the `ws-workstream-read` tool on an MCP session's server. Reads ONE
 * workstream by slug/id, or LISTs all live Workstreams (optionally filtered),
 * always returning the uniform `{ count, workstreams }` shape.
 */
export function registerWsWorkstreamRead(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-workstream-read',
    {
      title: 'Workstream: Read',
      description:
        'Read one Workstream or many. Read ONE by `slug` or `id`; otherwise LIST all Workstreams ' +
        '(newest-first), with an optional `query` case-insensitive substring filter and a `limit`. ' +
        'ALWAYS returns { count, workstreams } — a by-slug/id read yields a 0-or-1 element list, so ' +
        'callers get one uniform shape.',
      inputSchema: {
        slug: z.string().optional().describe('Read ONE workstream by slug.'),
        id: z.string().optional().describe('Read ONE workstream by document id (uuid).'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter over workstream text (list mode only).'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max workstreams to return (list mode only).'),
      },
    },
    async ({ slug, id, query, limit }) => {
      // Single read: by id or slug. A foreign-kind id maps to nothing (the
      // `ws-workstream-*` API only speaks Workstreams).
      if (id !== undefined || slug !== undefined) {
        const doc = store.getDocument({ id, slug, kind: WORKSTREAM_KIND });
        const workstreams = doc && doc.kind === WORKSTREAM_KIND ? [new Workstream(doc)] : [];
        return asText({ count: workstreams.length, workstreams });
      }
      // List mode: all live Workstreams, optional substring query + limit.
      let docs = store.listDocuments({ kind: WORKSTREAM_KIND });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, workstreams: docs.map((d) => new Workstream(d)) });
    },
  );
}
