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

const dockerRuntime = z.object({
  type: z.literal('docker'),
  buildContext: z.string().trim().min(1).max(1000),
  dockerfile: z.string().trim().min(1).max(500),
  imageName: z.string().trim().min(1).max(255),
  containerName: z.string().trim().min(1).max(255),
  hostPort: z.number().int().min(1).max(65535),
  containerPort: z.number().int().min(1).max(65535),
  healthPath: z.string().startsWith('/').max(500),
  entryPath: z.string().startsWith('/').max(500),
  volumes: z.array(z.object({
    name: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
    mountPath: z.string().startsWith('/').max(500),
  }).strict()).max(20).optional(),
}).strict();

const mcpEndpoint = z.object({
  transport: z.literal('streamable-http'),
  url: z.string().url().max(2000),
}).strict();

const applicationMetadata = z.object({
  id: z.string().trim().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  contractVersion: z.string().trim().min(1).max(100),
  discovery: z.object({
    toolName: z.string().trim().min(1).max(128),
    url: z.string().url().max(2000).optional(),
  }).strict(),
  capabilities: z.array(z.string().trim().min(1).max(100)).max(100),
  dataOwnership: z.literal('application'),
  healthUrl: z.string().url().max(2000).optional(),
  uiUrl: z.string().url().max(2000).optional(),
  httpUrl: z.string().url().max(2000).optional(),
}).strict();

const containerClaim: KindModule = {
  name: CONTAINER_CLAIM_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        title: z.string().trim().min(1).max(200),
        repository: z.string().trim().min(1).max(500),
        sourceRevision: z.string().trim().min(1).max(200).optional(),
        runtime: dockerRuntime.optional(),
        mcp: mcpEndpoint.optional(),
        application: applicationMetadata.optional(),
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
      `${row.spec.title}\n${row.spec.repository}\n${row.spec.sourceRevision ?? ''}\n` +
      `${(row.spec.application as { id?: string } | undefined)?.id ?? ''}`,
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