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
 * Soft-deletes a TopicType by ID, or restores a previously deleted one.
 */
export function registerWsTopicTypeDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topictype-delete',
    {
      title: 'TopicType: Delete',
      description:
        'Soft-delete a TopicType by `id` (it drops out of ws-topictype-read). To undelete, call ' +
        'with `restore: true`. Unknown/already-deleted IDs (or already-live IDs on restore) ' +
        'are rejected. Returns { ok, id }.',
      inputSchema: z.object({
        id: z.string().min(1).describe('ID of the topic type to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted topic type instead of deleting.'),
      }).strict(),
    },
    async ({ id, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({
        id,
        kind: TOPIC_TYPE_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== TOPIC_TYPE_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted topic type with ID "${id}" to restore.`
            : `Unknown topic type ID: "${id}". No live topic type with that ID.`,
        );
      }
      try {
        if (restore === true) {
          store.restoreDocument({ id: doc.metadata.id });
        } else {
          store.deleteDocument({ id: doc.metadata.id });
        }
        return asText({ ok: true, id });
      } catch (err) {
        if (err instanceof NotFoundError) {
          return asError(
            restore === true
              ? `No soft-deleted topic type with ID "${id}" to restore.`
              : `Unknown or already-deleted topic type ID: "${id}".`,
          );
        }
        throw err;
      }
    },
  );
}
