import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store, UpdateDocumentInput } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asError, asText } from '../toolResult.js';
import { WORKSTREAM_KIND } from '../workstream/shared.js';
import { Topic, TOPIC_KIND, stringArray } from './topic.js';

export function registerWsTopicTransfer(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topic-transfer',
    {
      title: 'Topic: Transfer',
      description:
        'Atomically copy or move a topic and all of its descendants between workstreams. ' +
        'Copy keeps source membership; move removes it and clears source focus.',
      inputSchema: {
        slug: z.string().min(1),
        sourceWorkstream: z.string().min(1),
        targetWorkstream: z.string().min(1),
        move: z.boolean().default(false),
      },
    },
    async ({ slug, sourceWorkstream, targetWorkstream, move }) => {
      if (sourceWorkstream === targetWorkstream) return asError('Source and target workstreams must differ.');
      for (const workstream of [sourceWorkstream, targetWorkstream]) {
        if (!store.getDocument({ slug: workstream, kind: WORKSTREAM_KIND })) {
          return asError(`Unknown workstream slug: "${workstream}". No live workstream with that slug.`);
        }
      }

      const documents = store.listDocuments({ kind: TOPIC_KIND });
      const bySlug = new Map(documents.flatMap((document) =>
        document.metadata.slug ? [[document.metadata.slug, document] as const] : []));
      const root = bySlug.get(slug);
      if (!root) return asError(`Unknown topic slug: "${slug}". No live topic with that slug.`);
      if (!stringArray(root.spec.workstreams).includes(sourceWorkstream)) {
        return asError(`Topic "${slug}" does not belong to source workstream "${sourceWorkstream}".`);
      }

      const children = new Map<string, string[]>();
      for (const document of documents) {
        const childSlug = document.metadata.slug;
        if (!childSlug || !stringArray(document.spec.workstreams).includes(sourceWorkstream)) continue;
        for (const parent of stringArray(document.spec.parents)) {
          children.set(parent, [...(children.get(parent) ?? []), childSlug]);
        }
      }
      const transferSlugs: string[] = [];
      const pending = [slug];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const current = pending.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);
        if (bySlug.has(current)) transferSlugs.push(current);
        pending.push(...(children.get(current) ?? []));
      }

      const batch: UpdateDocumentInput[] = [];
      for (const transferSlug of transferSlugs) {
        const existing = bySlug.get(transferSlug)!;
        const currentWorkstreams = stringArray(existing.spec.workstreams);
        const workstreams = currentWorkstreams.filter((workstream) => !move || workstream !== sourceWorkstream);
        if (!workstreams.includes(targetWorkstream)) workstreams.push(targetWorkstream);
        const focusedWorkstreams = stringArray(existing.spec.focusedWorkstreams)
          .filter((workstream) => !move || workstream !== sourceWorkstream);
        let spec: Record<string, unknown>;
        try {
          spec = validateSpec(TOPIC_KIND, { ...existing.spec, workstreams, focusedWorkstreams });
        } catch (error) {
          return asError((error as Error).message);
        }
        if (JSON.stringify(spec) === JSON.stringify(existing.spec)) continue;
        batch.push({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec,
        });
      }

      try {
        const updated = batch.length > 0 ? store.updateDocuments(batch) : [];
        const updatedById = new Map(updated.map((document) => [document.metadata.id, document]));
        return asText(transferSlugs.map((transferSlug) => {
          const existing = bySlug.get(transferSlug)!;
          return new Topic(updatedById.get(existing.metadata.id) ?? existing);
        }));
      } catch (error) {
        return asError((error as Error).message);
      }
    },
  );
}