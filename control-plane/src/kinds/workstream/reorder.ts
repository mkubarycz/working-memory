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
      inputSchema: z.object({
        updates: z.array(z.object({
          id: z.string().min(1),
          status: z.enum(['queue', 'progress', 'backlog']),
          position: z.number().finite(),
        }).strict()).min(1),
      }).strict(),
    },
    async ({ updates }) => {
      const ids = updates.map((update) => update.id);
      if (new Set(ids).size !== ids.length) return asError('Duplicate workstream ID in reorder request.');

      const batch: UpdateDocumentInput[] = [];
      for (const update of updates) {
        const existing = store.getDocument({ id: update.id, kind: WORKSTREAM_KIND });
        if (!existing) return asError(`Unknown workstream ID: "${update.id}". No live workstream with that ID.`);
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
