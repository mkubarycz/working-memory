/**
 * `ws-topic-read` — the Topic kind's Read/List tool.
 *
 * One of the four tool files in the `topic/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsTopicRead});
 * result helpers come from `../toolResult.js` and the `Topic` projection, kind
 * name + `stringArray` from `./topic.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import type { DocumentEnvelope, Store } from '../../store.js';
import { asText } from '../toolResult.js';
import { Topic, TOPIC_KIND, stringArray } from './topic.js';
const wsTopicReadInputSchema = z.object({
        metadataOnly: z.boolean().optional().describe('Omit authored bodies for relationship/tree metadata. Cannot be combined with a text query.'),
        id: z.string().min(1).optional().describe('Read ONE topic by document ID.'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter over topic text (list mode only).'),
        workstream: z
          .string()
          .optional()
          .describe('Filter to topics whose `workstreams` include this ID (list mode only).'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max topics to return (list mode only).'),
      }).strict().refine(input => !input.metadataOnly || input.query === undefined,
        { message: 'Metadata-only reads cannot be combined with a text query.' });


/**
 * Register the `ws-topic-read` tool on an MCP session's server. Reads ONE topic
 * by ID, or LISTs all live Topics (optionally filtered by substring or
 * workstream membership), always returning the uniform `{ count, topics }` shape.
 */
export function registerWsTopicRead(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topic-read',
    {
      title: 'Topic: Read',
      description:
        'Read one Topic or many. Read ONE by `id`; otherwise LIST all Topics ' +
        '(newest-first), with an optional `query` case-insensitive substring filter, a ' +
        '`workstream` membership filter (topics whose `workstreams` include that ID), and a ' +
        '`limit`. ALWAYS returns { count, topics } — a by-ID read yields a 0-or-1 element ' +
        'list, so callers get one uniform shape. Set metadataOnly to omit bodies for relationship/tree reads.',
      inputSchema: wsTopicReadInputSchema,
    },
    async ({ id, query, workstream, limit, metadataOnly }) => {
      const project = (doc: DocumentEnvelope) => {
        const topic = new Topic(doc);
        if (!metadataOnly) return topic;
        const { body: _body, ...metadata } = topic;
        return metadata;
      };
      // Single read: by ID. A foreign-kind ID maps to nothing (the
      // `ws-topic-*` API only speaks Topics).
      if (id !== undefined) {
        const doc = store.getDocument({ id, kind: TOPIC_KIND, omitBody: metadataOnly });
        const topics = doc && doc.kind === TOPIC_KIND ? [project(doc)] : [];
        return asText({ count: topics.length, topics });
      }
      // List mode: all live Topics, optional substring query + workstream
      // membership filter + limit.
      let docs = store.listDocuments({ kind: TOPIC_KIND, omitBody: metadataOnly });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
      }
      if (workstream !== undefined && workstream.trim() !== '') {
        docs = docs.filter((d) => stringArray(d.spec?.workstreams).includes(workstream));
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, topics: docs.map(project) });
    },
  );
}
