import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, type UpdateDocumentInput } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asError, asText } from '../toolResult.js';
import { TOPIC_KIND, stringArray } from './topic.js';

const MAX_CLOSE_TREE_TOPICS = 5_000;

export interface TopicCloseTreeResult {
  root: { id: string; slug: string; title: string; resourceVersion: number };
  dryRun: boolean;
  includeSharedDescendants: boolean;
  matchedCount: number;
  matchedSlugs: string[];
  closedCount: number;
  closedSlugs: string[];
  alreadyClosedCount: number;
  alreadyClosedSlugs: string[];
  skippedSharedCount: number;
  skippedSharedSlugs: string[];
}

export function registerWsTopicCloseTree(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topic-close-tree',
    {
      title: 'Topic: Close Tree',
      description:
        'Atomically close one topic and its descendant tree in a single call. Use this instead of many ' +
        'ws-topic-update calls whenever the user asks to close a topic plus its children or descendants. ' +
        'By default, descendants shared through any parent outside the closure are skipped, and that skip ' +
        'propagates to descendants until the remaining closure is exclusively owned. Set ' +
        '`includeSharedDescendants: true` only when the user intends to close every reachable descendant. ' +
        'Dry run returns the exact deterministic plan without writing.',
      inputSchema: {
        slug: z.string().min(1).describe('Root topic slug. The root is always included.'),
        includeSharedDescendants: z.boolean().default(false).describe(
          'Close descendants that also have parents outside the closure. Default false skips them and their no-longer-exclusive descendants.',
        ),
        dryRun: z.boolean().default(false).describe('Return the exact close plan without writing.'),
      },
    },
    async ({ slug, includeSharedDescendants, dryRun }) => {
      const documents = store.listDocuments({ kind: TOPIC_KIND });
      const bySlug = new Map(documents.flatMap((document) =>
        document.metadata.slug ? [[document.metadata.slug, document] as const] : []));
      const root = bySlug.get(slug);
      if (!root) return asError(`Unknown topic slug: "${slug}". No live topic with that slug.`);

      const children = new Map<string, string[]>();
      for (const document of documents) {
        const childSlug = document.metadata.slug;
        if (!childSlug) continue;
        for (const parent of stringArray(document.spec.parents)) {
          const siblings = children.get(parent) ?? [];
          siblings.push(childSlug);
          children.set(parent, siblings);
        }
      }
      for (const siblings of children.values()) siblings.sort((a, b) => a.localeCompare(b));

      const reachable: string[] = [];
      const seen = new Set<string>();
      const pending = [slug];
      for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
        const current = pending[pendingIndex];
        if (seen.has(current)) continue;
        seen.add(current);
        if (!bySlug.has(current)) continue;
        reachable.push(current);
        pending.push(...(children.get(current) ?? []));
      }
      if (reachable.length > MAX_CLOSE_TREE_TOPICS) {
        return asError(
          `Topic tree "${slug}" contains ${reachable.length} topics, exceeding the atomic close limit of ` +
          `${MAX_CLOSE_TREE_TOPICS}. Split the tree below the root and close smaller subtrees first.`,
        );
      }

      const reachableSet = new Set(reachable);
      const visited = new Set<string>();
      const activePathIndex = new Map<string, number>();
      const path = [slug];
      const dfsStack: Array<{ slug: string; nextChildIndex: number }> = [
        { slug, nextChildIndex: 0 },
      ];
      activePathIndex.set(slug, 0);
      let cycle: string[] | null = null;
      while (dfsStack.length > 0 && !cycle) {
        const frame = dfsStack[dfsStack.length - 1];
        const descendants = children.get(frame.slug) ?? [];
        if (frame.nextChildIndex >= descendants.length) {
          visited.add(frame.slug);
          activePathIndex.delete(frame.slug);
          dfsStack.pop();
          path.pop();
          continue;
        }
        const child = descendants[frame.nextChildIndex];
        frame.nextChildIndex += 1;
        if (!reachableSet.has(child) || visited.has(child)) continue;
        const activeIndex = activePathIndex.get(child);
        if (activeIndex !== undefined) {
          cycle = [...path.slice(activeIndex), child];
          break;
        }
        activePathIndex.set(child, path.length);
        path.push(child);
        dfsStack.push({ slug: child, nextChildIndex: 0 });
      }
      if (cycle) {
        return asError(`Cannot close topic tree "${slug}": parent cycle detected (${cycle.join(' -> ')}). No topics were changed.`);
      }

      const selected = new Set(reachable);
      if (!includeSharedDescendants) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const candidate of reachable) {
            if (candidate === slug || !selected.has(candidate)) continue;
            const parents = stringArray(bySlug.get(candidate)!.spec.parents);
            if (parents.some((parent) => !selected.has(parent))) {
              selected.delete(candidate);
              changed = true;
            }
          }
        }
      }

      const matchedSlugs = reachable.filter((candidate) => selected.has(candidate));
      const skippedSharedSlugs = reachable.filter((candidate) => !selected.has(candidate));
      const alreadyClosedSlugs = matchedSlugs.filter((candidate) => bySlug.get(candidate)!.spec.status === 'closed');
      const closedSlugs = matchedSlugs.filter((candidate) => bySlug.get(candidate)!.spec.status !== 'closed');
      const result: TopicCloseTreeResult = {
        root: {
          id: root.metadata.id,
          slug,
          title: typeof root.spec.title === 'string' ? root.spec.title : '',
          resourceVersion: root.metadata.resourceVersion,
        },
        dryRun,
        includeSharedDescendants,
        matchedCount: matchedSlugs.length,
        matchedSlugs,
        closedCount: closedSlugs.length,
        closedSlugs,
        alreadyClosedCount: alreadyClosedSlugs.length,
        alreadyClosedSlugs,
        skippedSharedCount: skippedSharedSlugs.length,
        skippedSharedSlugs,
      };
      if (dryRun || closedSlugs.length === 0) return asText(result);

      const batch: UpdateDocumentInput[] = closedSlugs.map((candidate) => {
        const document = bySlug.get(candidate)!;
        return {
          id: document.metadata.id,
          expectedResourceVersion: document.metadata.resourceVersion,
          spec: validateSpec(TOPIC_KIND, { ...document.spec, status: 'closed' }),
        };
      });
      try {
        store.updateDocuments(batch);
        return asText(result);
      } catch (error) {
        return asError(`Atomic close failed; no topics were closed. ${(error as Error).message}`);
      }
    },
  );
}
