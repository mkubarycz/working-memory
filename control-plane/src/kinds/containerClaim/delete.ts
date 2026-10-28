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
      inputSchema: z.object({
        id: z.string().min(1).describe('ID of the claim to delete or restore.'),
        restore: z.boolean().optional().describe('Restore a previously deleted claim.'),
      }).strict(),
    },
    async ({ id, restore }) => {
      const doc = store.getDocument({
        id,
        kind: CONTAINER_CLAIM_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== CONTAINER_CLAIM_KIND) {
        return asError(
          restore === true
            ? `No deleted container claim with ID "${id}" to restore.`
            : `Unknown container claim ID: "${id}". No live claim with that ID.`,
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
          return asError(`Container claim "${id}" could not be ${restore ? 'restored' : 'deleted'}.`);
        }
        throw err;
      }
    },
  );
}