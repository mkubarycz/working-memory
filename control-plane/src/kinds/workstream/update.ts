/**
 * `ws-workstream-update` — the Workstream kind's Update tool.
 *
 * One of the four tool files in the `workstream/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsWorkstreamUpdate});
 * shared helpers come from `./shared.js` and the `Workstream` projection from
 * `./workstream.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec } from '../registry.js';
import { WORKSTREAM_KIND, asText, asError } from './shared.js';
import { Workstream } from './workstream.js';

/**
 * Register the `ws-workstream-update` tool on an MCP session's server. Reads the
 * current document for its id + resourceVersion, merges the patch, re-validates
 * the whole spec against the Workstream kind, then does a compare-and-swap
 * write. Unknown slug and version conflicts are surfaced clearly.
 */
export function registerWsWorkstreamUpdate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-workstream-update',
    {
      title: 'Workstream: Update',
      description:
        'Update a Workstream identified by `slug`. Pass only the fields you are changing ' +
        '(`title`, `status`, `closure`). Reads the current document for its id + resourceVersion, ' +
        'then does a compare-and-swap write of the merged, re-validated spec. Unknown slug and ' +
        'version conflicts are surfaced clearly. Returns the updated workstream.',
      inputSchema: {
        slug: z.string().describe('Slug of the workstream to update (required).'),
        title: z.string().optional().describe('New title (≤120 chars).'),
        status: z
          .string()
          .optional()
          .describe("New lifecycle status: 'queue' | 'progress' | 'backlog' | 'closed'."),
        closure: z.string().optional().describe('New closure note.'),
      },
    },
    async ({ slug, title, status, closure }) => {
      const existing = store.getDocument({ slug, kind: WORKSTREAM_KIND });
      if (!existing) {
        return asError(`Unknown workstream slug: "${slug}". No live workstream with that slug.`);
      }
      const patch: Record<string, unknown> = {};
      if (title !== undefined) {
        patch.title = title;
      }
      if (status !== undefined) {
        patch.status = status;
      }
      if (closure !== undefined) {
        patch.closure = closure;
      }
      if (Object.keys(patch).length === 0) {
        // Nothing to change: return the current mapped workstream rather than a
        // no-op CAS write.
        return asText(new Workstream(existing));
      }
      let validatedSpec: Record<string, unknown>;
      try {
        // Merge the patch onto the current spec, then re-validate the whole spec
        // (invalid status rejected as kind validation). Persist the parsed value.
        validatedSpec = validateSpec(WORKSTREAM_KIND, { ...existing.spec, ...patch });
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec: validatedSpec,
        });
        return asText(new Workstream(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: workstream "${slug}" changed since it was read (current resourceVersion ` +
              `${err.currentResourceVersion}). Re-read with ws-workstream-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(
            `Unknown workstream slug: "${slug}". It no longer exists (it may have been deleted).`,
          );
        }
        throw err;
      }
    },
  );
}
