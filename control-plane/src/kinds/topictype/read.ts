/**
 * `ws-topictype-read` — the TopicType kind's Read/List tool.
 *
 * One of the four tool files in the `topictype/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsTopicTypeRead});
 * result helpers come from `../toolResult.js` and the `TopicType` projection +
 * kind name from `./topictype.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { asText } from '../toolResult.js';
import { TopicType, TOPIC_TYPE_KIND } from './topictype.js';

/**
 * Register the `ws-topictype-read` tool on an MCP session's server. Reads ONE
 * topic type by slug/id, or LISTs all live TopicTypes (optionally filtered),
 * always returning the uniform `{ count, topicTypes }` shape.
 */
export function registerWsTopicTypeRead(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topictype-read',
    {
      title: 'TopicType: Read',
      description:
        'Read one TopicType or many. Read ONE by `slug` or `id`; otherwise LIST all TopicTypes ' +
        '(newest-first), with an optional `query` case-insensitive substring filter and a `limit`. ' +
        'ALWAYS returns { count, topicTypes } — a by-slug/id read yields a 0-or-1 element list, so ' +
        'callers get one uniform shape.',
      inputSchema: {
        slug: z.string().optional().describe('Read ONE topic type by slug (registry key).'),
        id: z.string().optional().describe('Read ONE topic type by document id (uuid).'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter over topic-type text (list mode only).'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max topic types to return (list mode only).'),
      },
    },
    async ({ slug, id, query, limit }) => {
      // Single read: by id or slug. A foreign-kind id maps to nothing (the
      // `ws-topictype-*` API only speaks TopicTypes).
      if (id !== undefined || slug !== undefined) {
        const doc = store.getDocument({ id, slug, kind: TOPIC_TYPE_KIND });
        const topicTypes = doc && doc.kind === TOPIC_TYPE_KIND ? [new TopicType(doc)] : [];
        return asText({ count: topicTypes.length, topicTypes });
      }
      // List mode: all live TopicTypes, optional substring query + limit.
      let docs = store.listDocuments({ kind: TOPIC_TYPE_KIND });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, topicTypes: docs.map((d) => new TopicType(d)) });
    },
  );
}
