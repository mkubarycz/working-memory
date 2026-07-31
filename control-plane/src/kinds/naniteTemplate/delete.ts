/**
 * `ws-nanitetemplate-delete` — the NaniteTemplate kind's Delete/Restore tool.
 *
 * Soft-deletes a template by slug, or — with `restore: true` — undeletes one.
 * Mirrors `ws-topic-delete` (slug-based identity).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, NotFoundError } from '../../store.js';
import { asText, asError } from '../toolResult.js';
import { NANITE_TEMPLATE_KIND } from './naniteTemplate.js';

/** Register the `ws-nanitetemplate-delete` tool. */
export function registerWsNaniteTemplateDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanitetemplate-delete',
    {
      title: 'Nanite Template: Delete',
      description:
        'Soft-delete a Nanite Template by `slug` (it drops out of ws-nanitetemplate-read). To ' +
        'undelete, call with `restore: true`. Returns { ok, slug }.',
      inputSchema: {
        slug: z.string().describe('Slug of the template to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted template instead of deleting.'),
      },
    },
    async ({ slug, restore }) => {
      const doc = store.getDocument({
        slug,
        kind: NANITE_TEMPLATE_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== NANITE_TEMPLATE_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted nanite template with slug "${slug}" to restore.`
            : `Unknown nanite template slug: "${slug}". No live template with that slug.`,
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
              ? `No soft-deleted nanite template with slug "${slug}" to restore.`
              : `Unknown or already-deleted nanite template slug: "${slug}".`,
          );
        }
        throw err;
      }
    },
  );
}
