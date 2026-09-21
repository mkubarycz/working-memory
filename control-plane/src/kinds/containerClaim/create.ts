import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { defaultStatus, validateMetadata, validateSpec } from '../registry.js';
import { asError, asText } from '../toolResult.js';
import { ContainerClaim, CONTAINER_CLAIM_KIND } from './containerClaim.js';

export function registerWsContainerClaimCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-containerclaim-create',
    {
      title: 'Container Claim: Create',
      description:
        'Declare the desire to have a container running. Persists intent only. Provide a unique ' +
        '`slug`, human `title`, repository/codebase reference, and optional source revision. ' +
        'Omitting `sourceRevision` means the repository default.',
      inputSchema: {
        slug: z.string().describe('Stable claim slug: lowercase words separated with dashes.'),
        title: z.string().describe('Human-readable claim title (1-200 chars).'),
        repository: z.string().describe('Repository or codebase reference (1-500 chars).'),
        sourceRevision: z
          .string()
          .optional()
          .describe('Optional source branch, tag, or revision; omit to use the source default.'),
        runtime: z
          .object({
            type: z.literal('docker'),
            buildContext: z.string(),
            dockerfile: z.string(),
            imageName: z.string(),
            containerName: z.string(),
            hostPort: z.number().int(),
            containerPort: z.number().int(),
            healthPath: z.string(),
            entryPath: z.string(),
          })
          .strict()
          .optional()
          .describe('Optional local Docker build and runtime intent.'),
      },
    },
    async ({ slug, title, repository, sourceRevision, runtime }) => {
      const specInput: Record<string, unknown> = { title, repository };
      if (sourceRevision !== undefined) {
        specInput.sourceRevision = sourceRevision;
      }
      if (runtime !== undefined) {
        specInput.runtime = runtime;
      }
      try {
        validateMetadata(CONTAINER_CLAIM_KIND, { slug, store });
        const spec = validateSpec(CONTAINER_CLAIM_KIND, specInput);
        const doc = store.createDocument({
          kind: CONTAINER_CLAIM_KIND,
          slug,
          spec,
          status: defaultStatus(CONTAINER_CLAIM_KIND),
        });
        return asText(new ContainerClaim(doc));
      } catch (err) {
        return asError((err as Error).message);
      }
    },
  );
}