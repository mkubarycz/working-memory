/**
 * `ws-topictype-delete` — the TopicType kind's Delete/Restore tool.
 *
 * One of the four tool files in the `topictype/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsTopicTypeDelete});
 * result helpers come from `../toolResult.js` and the kind name from
 * `./topictype.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, NotFoundError } from '../../store.js';
import { asText, asError } from '../toolResult.js';
import { TOPIC_TYPE_KIND } from './topictype.js';

/**
 * Register the `ws-topictype-delete` tool on an MCP session's server.
 * Soft-deletes a TopicType by slug, or — with `restore: true` — undeletes a
 * previously soft-deleted one. Unknown/already-deleted slug (or an already-live
 * slug on restore) is rejected.
 */
export function registerWsTopicTypeDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topictype-delete',
    {
      title: 'TopicType: Delete',
      description:
        'Soft-delete a TopicType by `slug` (it drops out of ws-topictype-read). To undelete, call ' +
        'with `restore: true`. Unknown/already-deleted slug (or an already-live slug on restore) ' +
        'is rejected. Returns { ok, slug }.',
      inputSchema: {
        slug: z.string().describe('Slug of the topic type to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted topic type instead of deleting.'),
      },
    },
    async ({ slug, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({
        slug,
        kind: TOPIC_TYPE_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== TOPIC_TYPE_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted topic type with slug "${slug}" to restore.`
            : `Unknown topic type slug: "${slug}". No live topic type with that slug.`,
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
              ? `No soft-deleted topic type with slug "${slug}" to restore.`
              : `Unknown or already-deleted topic type slug: "${slug}".`,
          );
        }
        throw err;
      }
    },
  );
}
