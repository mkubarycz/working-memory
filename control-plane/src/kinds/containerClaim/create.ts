import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { defaultStatus, validateSpec } from '../registry.js';
import { asError, asText } from '../toolResult.js';
import { ContainerClaim, CONTAINER_CLAIM_KIND } from './containerClaim.js';

export function registerWsContainerClaimCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-containerclaim-create',
    {
      title: 'Container Claim: Create',
      description:
        'Declare the desire to have a container running. Persists intent only. Provide a human ' +
        '`title`, repository/codebase reference, and optional source revision. Returns a document ID. ' +
        'Omitting `sourceRevision` means the repository default.',
      inputSchema: z.object({
        title: z.string().describe('Human-readable claim title (1-200 chars).'),
        repository: z.string().describe('Repository or codebase reference (1-500 chars).'),
        sourceRevision: z
          .string()
          .optional()
          .describe('Optional source branch, tag, or revision; omit to use the source default.'),
        runtime: z.record(z.string(), z.unknown()).optional().describe('Optional local Docker build and runtime intent.'),
        mcp: z.record(z.string(), z.unknown()).optional().describe('Optional app-scoped MCP endpoint.'),
        application: z.record(z.string(), z.unknown()).optional().describe(
          'Optional application contract metadata: identity, version, discovery tool, capabilities, data ownership, and endpoints.',
        ),
        desktop: z.record(z.string(), z.unknown()).optional().describe(
          'Optional desktop presentation: codicon icon name and embeddable boolean. Docker claims appear automatically in the desktop app catalog.',
        ),
      }).strict(),
    },
    async ({ title, repository, sourceRevision, runtime, mcp, application, desktop }) => {
      const specInput: Record<string, unknown> = { title, repository };
      if (sourceRevision !== undefined) {
        specInput.sourceRevision = sourceRevision;
      }
      if (runtime !== undefined) specInput.runtime = runtime;
      if (mcp !== undefined) specInput.mcp = mcp;
      if (application !== undefined) specInput.application = application;
      if (desktop !== undefined) specInput.desktop = desktop;
      try {
        const spec = validateSpec(CONTAINER_CLAIM_KIND, specInput);
        const doc = store.createDocument({
          kind: CONTAINER_CLAIM_KIND,
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