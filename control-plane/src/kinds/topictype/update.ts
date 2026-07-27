/**
 * `ws-topictype-update` — the TopicType kind's Update tool.
 *
 * One of the four tool files in the `topictype/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsTopicTypeUpdate});
 * result helpers come from `../toolResult.js` and the `TopicType` projection +
 * kind name from `./topictype.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { TopicType, TOPIC_TYPE_KIND } from './topictype.js';

/**
 * Register the `ws-topictype-update` tool on an MCP session's server. Reads the
 * current document for its id + resourceVersion, merges the patch, re-validates
 * the whole spec against the TopicType kind, then does a compare-and-swap write.
 * Unknown slug and version conflicts are surfaced clearly.
 */
export function registerWsTopicTypeUpdate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topictype-update',
    {
      title: 'TopicType: Update',
      description:
        'Update a TopicType identified by `slug`. Pass only the fields you are changing (`label`, ' +
        '`icon`, `description`, `body_template`). Reads the current document for its id + ' +
        'resourceVersion, then does a compare-and-swap write of the merged, re-validated spec. ' +
        'Unknown slug and version conflicts are surfaced clearly. Returns the updated topic type.',
      inputSchema: {
        slug: z.string().describe('Slug of the topic type to update (required).'),
        label: z.string().optional().describe('New label.'),
        icon: z.string().optional().describe('New codicon id.'),
        description: z.string().optional().describe('New description.'),
        body_template: z.string().optional().describe('New body template.'),
      },
    },
    async ({ slug, label, icon, description, body_template }) => {
      const existing = store.getDocument({ slug, kind: TOPIC_TYPE_KIND });
      if (!existing) {
        return asError(`Unknown topic type slug: "${slug}". No live topic type with that slug.`);
      }
      const patch: Record<string, unknown> = {};
      if (label !== undefined) {
        patch.label = label;
      }
      if (icon !== undefined) {
        patch.icon = icon;
      }
      if (description !== undefined) {
        patch.description = description;
      }
      if (body_template !== undefined) {
        patch.body_template = body_template;
      }
      if (Object.keys(patch).length === 0) {
        // Nothing to change: return the current mapped topic type rather than a
        // no-op CAS write.
        return asText(new TopicType(existing));
      }
      let validatedSpec: Record<string, unknown>;
      try {
        // Merge the patch onto the current spec, then re-validate the whole spec.
        validatedSpec = validateSpec(TOPIC_TYPE_KIND, { ...existing.spec, ...patch });
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec: validatedSpec,
        });
        return asText(new TopicType(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: topic type "${slug}" changed since it was read (current resourceVersion ` +
              `${err.currentResourceVersion}). Re-read with ws-topictype-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(
            `Unknown topic type slug: "${slug}". It no longer exists (it may have been deleted).`,
          );
        }
        throw err;
      }
    },
  );
}
