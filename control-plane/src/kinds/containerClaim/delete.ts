import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { NotFoundError, type Store } from '../../store.js';
import { asError, asText } from '../toolResult.js';
import { CONTAINER_CLAIM_KIND } from './containerClaim.js';

export function registerWsContainerClaimDelete(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-containerclaim-delete',
    {
      title: 'Container Claim: Delete',
      description:
        'Remove the desire to have the claimed container running by soft-deleting the live claim. ' +
        'Pass `restore: true` to restore that intent.',
      inputSchema: {
        slug: z.string().describe('Slug of the claim to delete or restore.'),
        restore: z.boolean().optional().describe('Restore a previously deleted claim.'),
      },
    },
    async ({ slug, restore }) => {
      const doc = store.getDocument({
        slug,
        kind: CONTAINER_CLAIM_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== CONTAINER_CLAIM_KIND) {
        return asError(
          restore === true
            ? `No deleted container claim with slug "${slug}" to restore.`
            : `Unknown container claim slug: "${slug}". No live claim with that slug.`,
        );
      }
      try {
        if (restore === true) {
          const live = store.getDocument({ slug, kind: CONTAINER_CLAIM_KIND });
          if (live && live.metadata.id !== doc.metadata.id) {
            return asError(`Cannot restore container claim "${slug}": its slug is already in use.`);
          }
          store.restoreDocument({ id: doc.metadata.id });
        } else {
          store.deleteDocument({ id: doc.metadata.id });
        }
        return asText({ ok: true, slug });
      } catch (err) {
        if (err instanceof NotFoundError) {
          return asError(`Container claim "${slug}" could not be ${restore ? 'restored' : 'deleted'}.`);
        }
        throw err;
      }
    },
  );
}