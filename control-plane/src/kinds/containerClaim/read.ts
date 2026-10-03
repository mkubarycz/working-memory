import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { asText } from '../toolResult.js';
import { ContainerClaim, CONTAINER_CLAIM_KIND } from './containerClaim.js';

export function registerWsContainerClaimRead(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-containerclaim-read',
    {
      title: 'Container Claim: Read',
      description:
        'Read one live ContainerClaim by `slug` or `id`, or list live claims. Always returns ' +
        '`{ count, claims }`. Optional `query` matches claim text case-insensitively.',
      inputSchema: {
        slug: z.string().optional().describe('Read one claim by slug.'),
        id: z.string().optional().describe('Read one claim by document id.'),
        query: z.string().optional().describe('Case-insensitive substring filter in list mode.'),
        limit: z.number().int().positive().optional().describe('Maximum claims in list mode.'),
      },
    },
    async ({ slug, id, query, limit }) => {
      if (slug !== undefined || id !== undefined) {
        const doc = store.getDocument({
          ...(id !== undefined ? { id } : {}),
          ...(slug !== undefined ? { slug } : {}),
          kind: CONTAINER_CLAIM_KIND,
        });
        const claims = doc?.kind === CONTAINER_CLAIM_KIND ? [new ContainerClaim(doc)] : [];
        return asText({ count: claims.length, claims });
      }
      let docs = store.listDocuments({ kind: CONTAINER_CLAIM_KIND });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((doc) => JSON.stringify(doc).toLowerCase().includes(needle));
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, claims: docs.map((doc) => new ContainerClaim(doc)) });
    },
  );
}