/**
 * `ws-workstream-create` — the Workstream kind's Create tool.
 *
 * One of the four tool files in the `workstream/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsWorkstreamCreate});
 * shared helpers come from `./shared.js` and the `Workstream` projection from
 * `./workstream.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { validateMetadata, validateSpec, defaultStatus } from '../registry.js';
import { WORKSTREAM_KIND, asText, asError } from './shared.js';
import { Workstream } from './workstream.js';

function slugFromTitle(title: string): string {
  const normalized = title
    .trim()
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  if (normalized === '') {
    return 'workstream';
  }
  return /^[a-z]/.test(normalized) ? normalized : `workstream-${normalized}`;
}

function availableSlug(title: string, store: Store): string {
  const base = slugFromTitle(title);
  let candidate = base;
  let suffix = 2;
  while (store.getDocument({ kind: WORKSTREAM_KIND, slug: candidate, includeDeleted: true })) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Register the `ws-workstream-create` tool on an MCP session's server. The tool
 * speaks the legacy workstream shape and is backed by generic `store` document
 * ops for kind `Workstream`, with the kind's own `validateSpec` gating the write
 * (so an invalid status is rejected as kind validation, not a raw store error).
 */
export function registerWsWorkstreamCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-workstream-create',
    {
      title: 'Workstream: Create',
      description:
        'Create a Workstream. Provide a `title` (required, ≤120 chars). Omit `slug` to generate ' +
        'a unique lowercase dash-separated slug from the title, or provide an explicit valid slug. Also accepts an ' +
        "optional lifecycle `status` ('queue' | 'progress' | 'backlog' | 'closed', default " +
        "'progress'), and an optional `closure` note. The spec is validated against the " +
        'Workstream kind (invalid or duplicate slugs and invalid status are rejected). Returns the created workstream.',
      inputSchema: {
        slug: z
          .string()
          .optional()
          .describe('Optional explicit lowercase dash-separated slug. Omission generates a unique slug from title.'),
        title: z.string().describe('Workstream title (required, 1–120 chars).'),
        status: z
          .string()
          .optional()
          .describe(
            "Lifecycle status: 'queue' | 'progress' | 'backlog' | 'closed' (default 'progress').",
          ),
        closure: z.string().optional().describe('Closure note (set when closing a workstream).'),
      },
    },
    async ({ slug, title, status, closure }) => {
      const finalSlug = slug ?? availableSlug(title, store);
      const specInput: Record<string, unknown> = { title };
      if (status !== undefined) {
        specInput.status = status;
      }
      if (closure !== undefined) {
        specInput.closure = closure;
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        // Kind validation applies here (same as wm-document-create): parse +
        // default the spec against the Workstream schema; persist the parsed value.
        validateMetadata(WORKSTREAM_KIND, { slug: finalSlug, store });
        validatedSpec = validateSpec(WORKSTREAM_KIND, specInput);
        docStatus = defaultStatus(WORKSTREAM_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      const doc = store.createDocument({
        kind: WORKSTREAM_KIND,
        slug: finalSlug,
        spec: validatedSpec,
        status: docStatus,
      });
      return asText(new Workstream(doc));
    },
  );
}
