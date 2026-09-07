import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store, UpdateDocumentInput } from '../../store.js';
import { validateSpec } from '../registry.js';
import { WORKSTREAM_KIND, asError, asText } from './shared.js';
import { Workstream } from './workstream.js';

export function registerWsWorkstreamReorder(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-workstream-reorder',
    {
      title: 'Workstream: Reorder',
      description: 'Atomically update lifecycle section and sort position for a set of workstreams.',
      inputSchema: {
        updates: z.array(z.object({
          slug: z.string().min(1),
          status: z.enum(['queue', 'progress', 'backlog']),
          position: z.number().finite(),
        })).min(1),
      },
    },
    async ({ updates }) => {
      const slugs = updates.map((update) => update.slug);
      if (new Set(slugs).size !== slugs.length) return asError('Duplicate workstream slug in reorder request.');

      const batch: UpdateDocumentInput[] = [];
      for (const update of updates) {
        const existing = store.getDocument({ slug: update.slug, kind: WORKSTREAM_KIND });
        if (!existing) return asError(`Unknown workstream slug: "${update.slug}". No live workstream with that slug.`);
        let spec: Record<string, unknown>;
        try {
          spec = validateSpec(WORKSTREAM_KIND, {
            ...existing.spec,
            status: update.status,
            position: update.position,
          });
        } catch (error) {
          return asError((error as Error).message);
        }
        batch.push({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec,
        });
      }

      try {
        return asText(store.updateDocuments(batch).map((document) => new Workstream(document)));
      } catch (error) {
        return asError((error as Error).message);
      }
    },
  );
}
