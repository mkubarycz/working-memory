/**
 * `ws-nanitetemplate-update` — the NaniteTemplate kind's Update tool.
 *
 * One of the four tool files in the `naniteTemplate/` kind folder. Reads the
 * current document (by slug) for its resourceVersion, merges the patch,
 * re-validates the whole spec, then does a compare-and-swap write. Mirrors
 * `ws-topic-update`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { NaniteTemplate, NANITE_TEMPLATE_KIND } from './naniteTemplate.js';

/** Register the `ws-nanitetemplate-update` tool. */
export function registerWsNaniteTemplateUpdate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanitetemplate-update',
    {
      title: 'Nanite Template: Update',
      description:
        'Update a Nanite Template identified by `slug`. Pass only the fields you are changing ' +
        '(`title`, `triggerPhrase`, `instructions`, `executionSettings`, `toolAllowlist`, `toolDenylist`, ' +
        '`inputSchema`, `outputSchema`, `acceptanceCriteria`, `acceptanceThreshold`, `enabled`). ' +
        'Reads the current document for its resourceVersion, then does a compare-and-swap write of ' +
        'the merged, re-validated spec. Returns the updated template.',
      inputSchema: {
        slug: z.string().describe('Slug of the template to update (required).'),
        title: z.string().optional().describe('New title.'),
        triggerPhrase: z.string().optional().describe('New trigger phrase.'),
        instructions: z.string().optional().describe('New instructions.'),
        executionSettings: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Replacement execution settings.'),
        toolAllowlist: z.array(z.string()).optional().describe('Replacement tool allowlist.'),
        toolDenylist: z.array(z.string()).optional().describe('Replacement tool denylist.'),
        allowRunWithoutHuman: z.boolean().optional().describe('Allow unattended dispatch (no human approval).'),
        inputSchema: z.record(z.string(), z.unknown()).optional().describe('Replacement input schema.'),
        outputSchema: z.record(z.string(), z.unknown()).optional().describe('Replacement output schema.'),
        acceptanceCriteria: z.string().optional().describe('New acceptance criteria.'),
        acceptanceThreshold: z.number().optional().describe('New acceptance threshold (0-100).'),
        enabled: z.boolean().optional().describe('New enabled flag.'),
      },
    },
    async ({ slug, ...rest }) => {
      const existing = store.getDocument({ slug, kind: NANITE_TEMPLATE_KIND });
      if (!existing || existing.kind !== NANITE_TEMPLATE_KIND) {
        return asError(`Unknown nanite template slug: "${slug}". No live template with that slug.`);
      }
      const patch: Record<string, unknown> = {};
      for (const key of [
        'title',
        'triggerPhrase',
        'instructions',
        'executionSettings',
        'toolAllowlist',
        'toolDenylist',
        'allowRunWithoutHuman',
        'inputSchema',
        'outputSchema',
        'acceptanceCriteria',
        'acceptanceThreshold',
        'enabled',
      ] as const) {
        if (rest[key] !== undefined) {
          patch[key] = rest[key];
        }
      }
      if (Object.keys(patch).length === 0) {
        return asText(new NaniteTemplate(existing));
      }
      let validatedSpec: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(NANITE_TEMPLATE_KIND, { ...existing.spec, ...patch });
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec: validatedSpec,
        });
        return asText(new NaniteTemplate(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: nanite template "${slug}" changed since it was read (current ` +
              `resourceVersion ${err.currentResourceVersion}). Re-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(`Unknown nanite template slug: "${slug}". It no longer exists.`);
        }
        throw err;
      }
    },
  );
}
