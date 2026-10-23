import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, type UpdateDocumentInput } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asError, asText } from '../toolResult.js';
import { TOPIC_KIND, stringArray } from './topic.js';

const MAX_CLOSE_TREE_TOPICS = 5_000;

export interface TopicCloseTreeResult {
  root: { id: string; title: string; resourceVersion: number };
  dryRun: boolean;
  includeSharedDescendants: boolean;
  matchedCount: number;
  matchedIds: string[];
  closedCount: number;
  closedIds: string[];
  alreadyClosedCount: number;
  alreadyClosedIds: string[];
  skippedSharedCount: number;
  skippedSharedIds: string[];
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
      inputSchema: z.object({
        id: z.string().min(1).describe('Root topic ID. The root is always included.'),
        includeSharedDescendants: z.boolean().default(false).describe(
          'Close descendants that also have parents outside the closure. Default false skips them and their no-longer-exclusive descendants.',
        ),
        dryRun: z.boolean().default(false).describe('Return the exact close plan without writing.'),
      }).strict(),
    },
    async ({ id, includeSharedDescendants, dryRun }) => {
      const documents = store.listDocuments({ kind: TOPIC_KIND });
      const byId = new Map(documents.map((document) => [document.metadata.id, document]));
      const root = byId.get(id);
      if (!root) return asError(`Unknown topic ID: "${id}". No live topic with that ID.`);

      const children = new Map<string, string[]>();
      for (const document of documents) {
        const childId = document.metadata.id;
        for (const parent of stringArray(document.spec.parents)) {
          const siblings = children.get(parent) ?? [];
          siblings.push(childId);
          children.set(parent, siblings);
        }
      }
      for (const siblings of children.values()) siblings.sort((a, b) => a.localeCompare(b));

      const reachable: string[] = [];
      const seen = new Set<string>();
      const pending = [id];
      for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
        const current = pending[pendingIndex];
        if (seen.has(current)) continue;
        seen.add(current);
        if (!byId.has(current)) continue;
        reachable.push(current);
        pending.push(...(children.get(current) ?? []));
      }
      if (reachable.length > MAX_CLOSE_TREE_TOPICS) {
        return asError(
          `Topic tree "${id}" contains ${reachable.length} topics, exceeding the atomic close limit of ` +
          `${MAX_CLOSE_TREE_TOPICS}. Split the tree below the root and close smaller subtrees first.`,
        );
      }

      const reachableSet = new Set(reachable);
      const visited = new Set<string>();
      const activePathIndex = new Map<string, number>();
      const path = [id];
      const dfsStack: Array<{ id: string; nextChildIndex: number }> = [
        { id, nextChildIndex: 0 },
      ];
      activePathIndex.set(id, 0);
      let cycle: string[] | null = null;
      while (dfsStack.length > 0 && !cycle) {
        const frame = dfsStack[dfsStack.length - 1];
        const descendants = children.get(frame.id) ?? [];
        if (frame.nextChildIndex >= descendants.length) {
          visited.add(frame.id);
          activePathIndex.delete(frame.id);
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
        dfsStack.push({ id: child, nextChildIndex: 0 });
      }
      if (cycle) {
        return asError(`Cannot close topic tree "${id}": parent cycle detected (${cycle.join(' -> ')}). No topics were changed.`);
      }

      const selected = new Set(reachable);
      if (!includeSharedDescendants) {
        let changed = true;
        while (changed) {
          changed = false;
          for (const candidate of reachable) {
            if (candidate === id || !selected.has(candidate)) continue;
            const parents = stringArray(byId.get(candidate)!.spec.parents);
            if (parents.some((parent) => !selected.has(parent))) {
              selected.delete(candidate);
              changed = true;
            }
          }
        }
      }

      const matchedIds = reachable.filter((candidate) => selected.has(candidate));
      const skippedSharedIds = reachable.filter((candidate) => !selected.has(candidate));
      const alreadyClosedIds = matchedIds.filter((candidate) => byId.get(candidate)!.spec.status === 'closed');
      const closedIds = matchedIds.filter((candidate) => byId.get(candidate)!.spec.status !== 'closed');
      const result: TopicCloseTreeResult = {
        root: {
          id: root.metadata.id,
          title: typeof root.spec.title === 'string' ? root.spec.title : '',
          resourceVersion: root.metadata.resourceVersion,
        },
        dryRun,
        includeSharedDescendants,
        matchedCount: matchedIds.length,
        matchedIds,
        closedCount: closedIds.length,
        closedIds,
        alreadyClosedCount: alreadyClosedIds.length,
        alreadyClosedIds,
        skippedSharedCount: skippedSharedIds.length,
        skippedSharedIds,
      };
      if (dryRun || closedIds.length === 0) return asText(result);

      const batch: UpdateDocumentInput[] = closedIds.map((candidate) => {
        const document = byId.get(candidate)!;
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
