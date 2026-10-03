import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConflictError, NotFoundError, type Store } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asError, asText } from '../toolResult.js';
import { ContainerClaim, CONTAINER_CLAIM_KIND } from './containerClaim.js';

export function registerWsContainerClaimUpdate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-containerclaim-update',
    {
      title: 'Container Claim: Update',
      description:
        'Update the authored intent of a live ContainerClaim by `slug`. Pass only `title`, ' +
        '`repository`, `sourceRevision`, runtime, MCP, or application metadata; the stable slug is not changed.',
      inputSchema: {
        slug: z.string().describe('Slug of the live claim to update.'),
        title: z.string().optional().describe('Replacement human-readable title.'),
        repository: z.string().optional().describe('Replacement repository/codebase reference.'),
        sourceRevision: z
          .string()
          .nullable()
          .optional()
          .describe('Replacement source revision, or null to return to the repository default.'),
        runtime: z.record(z.string(), z.unknown()).nullable().optional(),
        mcp: z.record(z.string(), z.unknown()).nullable().optional(),
        application: z.record(z.string(), z.unknown()).nullable().optional(),
      },
    },
    async ({ slug, ...input }) => {
      const existing = store.getDocument({ slug, kind: CONTAINER_CLAIM_KIND });
      if (!existing || existing.kind !== CONTAINER_CLAIM_KIND) {
        return asError(`Unknown container claim slug: "${slug}". No live claim with that slug.`);
      }
      const patch = Object.fromEntries(
        Object.entries(input).filter(([, value]) => value !== undefined),
      );
      if (Object.keys(patch).length === 0) {
        return asText(new ContainerClaim(existing));
      }
      let spec: Record<string, unknown>;
      try {
        const merged = { ...existing.spec, ...patch };
        for (const optional of ['sourceRevision', 'runtime', 'mcp', 'application']) {
          if (merged[optional] === null) delete merged[optional];
        }
        spec = validateSpec(CONTAINER_CLAIM_KIND, merged);
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec,
        });
        return asText(new ContainerClaim(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: container claim "${slug}" changed since it was read (current ` +
              `resourceVersion ${err.currentResourceVersion}). Re-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(`Unknown container claim slug: "${slug}". It no longer exists.`);
        }
        throw err;
      }
    },
  );
}