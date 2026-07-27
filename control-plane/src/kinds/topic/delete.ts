/**
 * `ws-topic-delete` — the Topic kind's Delete/Restore tool.
 *
 * One of the four tool files in the `topic/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsTopicDelete});
 * result helpers come from `../toolResult.js` and the kind name from `./topic.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, NotFoundError } from '../../store.js';
import { asText, asError } from '../toolResult.js';
import { TOPIC_KIND } from './topic.js';

/**
 * Register the `ws-topic-delete` tool on an MCP session's server. Soft-deletes a
 * Topic by slug, or — with `restore: true` — undeletes a previously soft-deleted
 * one. Unknown/already-deleted slug (or an already-live slug on restore) is
 * rejected.
 */
export function registerWsTopicDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topic-delete',
    {
      title: 'Topic: Delete',
      description:
        'Soft-delete a Topic by `slug` (it drops out of ws-topic-read). To undelete, call with ' +
        '`restore: true`. Unknown/already-deleted slug (or an already-live slug on restore) is ' +
        'rejected. Returns { ok, slug }.',
      inputSchema: {
        slug: z.string().describe('Slug of the topic to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted topic instead of deleting.'),
      },
    },
    async ({ slug, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({
        slug,
        kind: TOPIC_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== TOPIC_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted topic with slug "${slug}" to restore.`
            : `Unknown topic slug: "${slug}". No live topic with that slug.`,
        );
      }
      try {
        if (restore === true) {
          store.restoreDocument({ id: doc.metadata.id });
        } else {
          store.deleteDocument({ id: doc.metadata.id });
        }
        return asText({ ok: true, slug });
      } catch (err) {
        if (err instanceof NotFoundError) {
          return asError(
            restore === true
              ? `No soft-deleted topic with slug "${slug}" to restore.`
              : `Unknown or already-deleted topic slug: "${slug}".`,
          );
        }
        throw err;
      }
    },
  );
}
