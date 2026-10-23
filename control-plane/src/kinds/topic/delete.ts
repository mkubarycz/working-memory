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
 * Topic by ID, or — with `restore: true` — undeletes a previously soft-deleted
 * one. Unknown/already-deleted IDs (or already-live IDs on restore) are
 * rejected.
 */
export function registerWsTopicDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topic-delete',
    {
      title: 'Topic: Delete',
      description:
        'Soft-delete a Topic by `id` (it drops out of ws-topic-read). To undelete, call with ' +
        '`restore: true`. Unknown/already-deleted IDs (or already-live IDs on restore) are ' +
        'rejected. Returns { ok, id }.',
      inputSchema: z.object({
        id: z.string().min(1).describe('ID of the topic to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted topic instead of deleting.'),
      }).strict(),
    },
    async ({ id, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({
        id,
        kind: TOPIC_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== TOPIC_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted topic with ID "${id}" to restore.`
            : `Unknown topic ID: "${id}". No live topic with that ID.`,
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
              ? `No soft-deleted topic with ID "${id}" to restore.`
              : `Unknown or already-deleted topic ID: "${id}".`,
          );
        }
        throw err;
      }
    },
  );
}
