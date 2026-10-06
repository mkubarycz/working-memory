/**
 * `ws-topic-update` — the Topic kind's Update tool.
 *
 * One of the four tool files in the `topic/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsTopicUpdate});
 * result helpers come from `../toolResult.js` and the `Topic` projection + kind
 * name from `./topic.js`.
 *
 * NOTE: `spec.workstreams`, `spec.focusedWorkstreams` and `spec.parents` are
 * ordinary spec fields, so this one Update tool fully edits topic↔workstream
 * membership, per-workstream focus pins and parent links — there are no bespoke
 * attach/detach tools.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { Topic, TOPIC_KIND } from './topic.js';

function validateParents(store: Store, slug: string, parents: string[]): string | null {
  if (new Set(parents).size !== parents.length) {
    return 'A topic cannot list the same parent more than once.';
  }
  const topics = new Map(
    store.listDocuments({ kind: TOPIC_KIND })
      .filter((document) => document.metadata.slug)
      .map((document) => [document.metadata.slug!, document]),
  );
  for (const parent of parents) {
    if (!topics.has(parent)) {
      return `Unknown parent topic slug: "${parent}".`;
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const hasCycle = (candidate: string): boolean => {
    if (visiting.has(candidate)) return true;
    if (visited.has(candidate)) return false;
    visiting.add(candidate);
    const candidateParents = candidate === slug
      ? parents
      : ((topics.get(candidate)?.spec.parents as string[] | undefined) ?? []);
    const cycle = candidateParents.some(hasCycle);
    visiting.delete(candidate);
    visited.add(candidate);
    return cycle;
  };
  return hasCycle(slug) ? `Cannot reparent "${slug}": the parent change would create a cycle.` : null;
}

/**
 * Register the `ws-topic-update` tool on an MCP session's server. Reads the
 * current document for its id + resourceVersion, merges the patch, re-validates
 * the whole spec against the Topic kind, then does a compare-and-swap write.
 * Unknown slug and version conflicts are surfaced clearly.
 */
export function registerWsTopicUpdate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topic-update',
    {
      title: 'Topic: Update',
      description:
        'Update a Topic identified by `slug`. Pass only the fields you are changing (`title`, ' +
        '`body`, `status`, `topicType`, `parents`, `workstreams`, `focusedWorkstreams`). Reads ' +
        'the current document for its id + resourceVersion, then does a compare-and-swap write of ' +
        'the merged, re-validated spec. Unknown slug and version conflicts are surfaced clearly. ' +
        'Returns the updated topic. To close a topic together with children/descendants, use the ' +
        'single atomic ws-topic-close-tree tool instead of issuing many update calls.',
      inputSchema: {
        slug: z.string().describe('Slug of the topic to update (required).'),
        title: z.string().optional().describe('New title (≤120 chars).'),
        body: z.string().optional().describe('New body.'),
        status: z.string().optional().describe("New status: 'open' | 'closed'."),
        topicType: z.string().optional().describe('New topic type.'),
        parents: z.array(z.string()).optional().describe('Replacement parent topic slugs.'),
        workstreams: z
          .array(z.string())
          .optional()
          .describe('Replacement member workstream slugs.'),
        focusedWorkstreams: z
          .array(z.string())
          .optional()
          .describe('Replacement focused-in workstream slugs (subset of `workstreams`).'),
      },
    },
    async ({ slug, title, body, status, topicType, parents, workstreams, focusedWorkstreams }) => {
      const existing = store.getDocument({ slug, kind: TOPIC_KIND });
      if (!existing) {
        return asError(`Unknown topic slug: "${slug}". No live topic with that slug.`);
      }
      const patch: Record<string, unknown> = {};
      if (title !== undefined) {
        patch.title = title;
      }
      if (body !== undefined) {
        patch.body = body;
      }
      if (status !== undefined) {
        patch.status = status;
      }
      if (topicType !== undefined) {
        patch.topicType = topicType;
      }
      if (parents !== undefined) {
        const parentError = validateParents(store, slug, parents);
        if (parentError) {
          return asError(parentError);
        }
        patch.parents = parents;
      }
      if (workstreams !== undefined) {
        patch.workstreams = workstreams;
        if (focusedWorkstreams === undefined) {
          const currentFocusedWorkstreams = Array.isArray(existing.spec.focusedWorkstreams)
            ? existing.spec.focusedWorkstreams.filter(
                (workstream): workstream is string => typeof workstream === 'string',
              )
            : [];
          patch.focusedWorkstreams = currentFocusedWorkstreams.filter(
            (workstream) => workstreams.includes(workstream),
          );
        }
      }
      if (focusedWorkstreams !== undefined) {
        patch.focusedWorkstreams = focusedWorkstreams;
      }
      if (Object.keys(patch).length === 0) {
        // Nothing to change: return the current mapped topic rather than a no-op
        // CAS write.
        return asText(new Topic(existing));
      }
      let validatedSpec: Record<string, unknown>;
      try {
        // Merge the patch onto the current spec, then re-validate the whole spec
        // (invalid status rejected as kind validation). Persist the parsed value.
        validatedSpec = validateSpec(TOPIC_KIND, { ...existing.spec, ...patch });
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec: validatedSpec,
        });
        return asText(new Topic(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: topic "${slug}" changed since it was read (current resourceVersion ` +
              `${err.currentResourceVersion}). Re-read with ws-topic-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(
            `Unknown topic slug: "${slug}". It no longer exists (it may have been deleted).`,
          );
        }
        throw err;
      }
    },
  );
}
