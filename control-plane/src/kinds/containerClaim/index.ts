import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { CONTAINER_CLAIM_KIND } from './containerClaim.js';
import { registerWsContainerClaimCreate } from './create.js';
import { registerWsContainerClaimRead } from './read.js';
import { registerWsContainerClaimUpdate } from './update.js';
import { registerWsContainerClaimDelete } from './delete.js';

export type { IContainerClaim } from './containerClaim.js';

const containerClaim: KindModule = {
  name: CONTAINER_CLAIM_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        title: z.string().trim().min(1).max(200),
        repository: z.string().trim().min(1).max(500),
        sourceRevision: z.string().trim().min(1).max(200).optional(),
      })
      .strict(),
    validateMetadata: ({ slug, store, excludeId }) => {
      const convention =
        'A ContainerClaim requires a unique slug: lowercase words separated with dashes.';
      if (
        typeof slug !== 'string' ||
        slug.trim() === '' ||
        !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)
      ) {
        throw new Error(convention);
      }
      const existing = store.getDocument({
        slug,
        kind: CONTAINER_CLAIM_KIND,
        includeDeleted: true,
      });
      if (existing && existing.metadata.id !== excludeId) {
        throw new Error(`${convention} "${slug}" is already in use.`);
      }
    },
    fts: (row) =>
      `${row.spec.title}\n${row.spec.repository}\n${row.spec.sourceRevision ?? ''}`,
  },
  registerApi: registerContainerClaimApi,
};

function registerContainerClaimApi(server: McpServer, store: Store): void {
  registerWsContainerClaimCreate(server, store);
  registerWsContainerClaimRead(server, store);
  registerWsContainerClaimUpdate(server, store);
  registerWsContainerClaimDelete(server, store);
}

export default containerClaim;