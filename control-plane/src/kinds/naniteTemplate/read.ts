/**
 * `ws-nanitetemplate-read` — the NaniteTemplate kind's Read/List tool.
 *
 * One of the four tool files in the `naniteTemplate/` kind folder. Mirrors
 * `ws-topic-read`: read ONE by slug (or id), or LIST all live templates.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { asText } from '../toolResult.js';
import { NaniteTemplate, NANITE_TEMPLATE_KIND } from './naniteTemplate.js';

/**
 * Register the `ws-nanitetemplate-read` tool. Reads ONE template by slug/id, or
 * LISTs all live templates (optionally filtered), always returning the uniform
 * `{ count, templates }` shape.
 */
export function registerWsNaniteTemplateRead(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanitetemplate-read',
    {
      title: 'Nanite Template: Read',
      description:
        'Read one Nanite Template or many. Read ONE by `slug` (or `id`); otherwise LIST all ' +
        'templates, with an optional `query` case-insensitive substring filter and a `limit`. ' +
        'ALWAYS returns { count, templates } — a by-slug read yields a 0-or-1 element list.',
      inputSchema: {
        slug: z.string().optional().describe('Read ONE template by slug.'),
        id: z.string().optional().describe('Read ONE template by document id (uuid).'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter over template text (list mode only).'),
        limit: z.number().int().positive().optional().describe('Max templates (list mode only).'),
      },
    },
    async ({ slug, id, query, limit }) => {
      if (slug !== undefined || id !== undefined) {
        const doc = store.getDocument({
          ...(id !== undefined ? { id } : {}),
          ...(slug !== undefined ? { slug } : {}),
          kind: NANITE_TEMPLATE_KIND,
        });
        const templates =
          doc && doc.kind === NANITE_TEMPLATE_KIND ? [new NaniteTemplate(doc)] : [];
        return asText({ count: templates.length, templates });
      }
      let docs = store.listDocuments({ kind: NANITE_TEMPLATE_KIND });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, templates: docs.map((d) => new NaniteTemplate(d)) });
    },
  );
}
