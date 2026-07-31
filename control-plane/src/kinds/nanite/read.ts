/**
 * `ws-nanite-read` — the Nanite kind's Read/List tool.
 *
 * Read ONE by id, or LIST all live Nanites, optionally filtered by `inputTopic`
 * (the panel groups nanites under their input topic this way) or `workstream`.
 * Always returns the uniform `{ count, nanites }` shape.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { asText } from '../toolResult.js';
import { Nanite, NANITE_KIND } from './nanite.js';

/** Register the `ws-nanite-read` tool. */
export function registerWsNaniteRead(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanite-read',
    {
      title: 'Nanite: Read',
      description:
        'Read one Nanite or many. Read ONE by `id`; otherwise LIST all Nanites (newest-first), ' +
        'optionally filtered by `inputTopic` (topic slug), `workstream` (workstream slug), and/or ' +
        '`phase` (e.g. `Queued` for the dispatcher), with an optional `limit`. ALWAYS returns ' +
        '{ count, nanites }.',
      inputSchema: {
        id: z.string().optional().describe('Read ONE nanite by document id (uuid).'),
        inputTopic: z.string().optional().describe('Filter to nanites whose input topic is this slug.'),
        workstream: z.string().optional().describe('Filter to nanites owned by this workstream slug.'),
        phase: z
          .enum(['Pending', 'Queued', 'Running', 'Succeeded', 'Failed'])
          .optional()
          .describe('Filter to nanites in this lifecycle phase.'),
        limit: z.number().int().positive().optional().describe('Max nanites to return (list mode).'),
      },
    },
    async ({ id, inputTopic, workstream, phase, limit }) => {
      if (id !== undefined) {
        const doc = store.getDocument({ id, kind: NANITE_KIND });
        const nanites = doc && doc.kind === NANITE_KIND ? [new Nanite(doc)] : [];
        return asText({ count: nanites.length, nanites });
      }
      let docs = store.listDocuments({ kind: NANITE_KIND });
      if (inputTopic !== undefined) {
        docs = docs.filter((d) => d.spec?.inputTopic === inputTopic);
      }
      if (workstream !== undefined) {
        docs = docs.filter((d) => d.spec?.workstream === workstream);
      }
      if (phase !== undefined) {
        docs = docs.filter((d) => d.spec?.phase === phase);
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, nanites: docs.map((d) => new Nanite(d)) });
    },
  );
}
