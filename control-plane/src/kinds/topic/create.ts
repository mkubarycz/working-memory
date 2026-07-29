/**
 * `ws-topic-create` — the Topic kind's Create tool.
 *
 * One of the four tool files in the `topic/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsTopicCreate});
 * result helpers come from `../toolResult.js` and the `Topic` projection + kind
 * name from `./topic.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { Topic, TOPIC_KIND, stringArray } from './topic.js';

/**
 * Register the `ws-topic-create` tool on an MCP session's server. The tool
 * speaks the legacy topic shape and is backed by generic `store` document ops
 * for kind `Topic`, with the kind's own `validateSpec` gating the write (so an
 * invalid status is rejected as kind validation, not a raw store error).
 */
export function registerWsTopicCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topic-create',
    {
      title: 'Topic: Create',
      description:
        'Create a Topic. Provide a `title` (required, ≤120 chars); optional `slug`, `body`, ' +
        "`status` ('open' | 'closed', default 'open'), `topicType` (default 'topic'), `parents` " +
        '(parent topic slugs), `workstreams` (member workstream slugs), and `focusedWorkstreams` ' +
        '(subset of `workstreams` this topic is pinned/focused in). Every topic MUST belong to ' +
        '≥1 workstream: choose the one the current session/task is about from context — NEVER an ' +
        'arbitrary or random workstream; if you are not ≥90% sure which one it belongs to, ask the ' +
        'user before creating it. The spec is validated ' +
        'against the Topic kind (invalid status rejected). Returns the created topic.',
      inputSchema: {
        slug: z.string().optional().describe('Optional human-friendly slug for the topic.'),
        title: z.string().describe('Topic title (required, 1–120 chars).'),
        body: z.string().optional().describe('Topic body (markdown).'),
        status: z
          .string()
          .optional()
          .describe("Authored status: 'open' | 'closed' (default 'open')."),
        topicType: z.string().optional().describe("Topic type discriminator (default 'topic')."),
        parents: z.array(z.string()).optional().describe('Parent topic slugs.'),
        workstreams: z
          .array(z.string())
          .optional()
          .describe(
            'Member workstream slugs (topic membership) — a topic MUST belong to ≥1 workstream. ' +
              'Pick the workstream the current session/task is about, inferred from context; NEVER ' +
              'assign an arbitrary or random workstream just to satisfy the requirement. If you are ' +
              'less than ~90% confident which workstream this belongs to, ask the user instead of ' +
              "guessing. May be omitted only when `parents` are given — then it inherits the parents' " +
              'workstreams.',
          ),
        focusedWorkstreams: z
          .array(z.string())
          .optional()
          .describe('Subset of `workstreams` this topic is focused/pinned in.'),
      },
    },
    async ({ slug, title, body, status, topicType, parents, workstreams, focusedWorkstreams }) => {
      const specInput: Record<string, unknown> = { title };
      if (body !== undefined) {
        specInput.body = body;
      }
      if (status !== undefined) {
        specInput.status = status;
      }
      if (topicType !== undefined) {
        specInput.topicType = topicType;
      }
      if (parents !== undefined) {
        specInput.parents = parents;
      }
      // Workstream membership resolution (before schema validation):
      //   - explicit non-empty `workstreams` → use as-is.
      //   - none supplied but `parents` given → inherit the UNION of those
      //     parents' current `workstreams` (resolve each parent slug via store).
      //   - still empty after that → reject with the friendly invariant message,
      //     so the schema `.min(1)` backstop only fires for genuine orphans.
      const suppliedWorkstreams = workstreams ?? [];
      let effectiveWorkstreams = suppliedWorkstreams;
      if (effectiveWorkstreams.length === 0 && parents !== undefined && parents.length > 0) {
        const inherited = new Set<string>();
        for (const parentSlug of parents) {
          const parentDoc = store.getDocument({ slug: parentSlug, kind: TOPIC_KIND });
          if (parentDoc) {
            for (const ws of stringArray(parentDoc.spec?.workstreams)) {
              inherited.add(ws);
            }
          }
        }
        effectiveWorkstreams = [...inherited];
      }
      if (effectiveWorkstreams.length === 0) {
        return asError(
          'a topic must belong to at least one workstream (none supplied and no parent ' +
            'workstream to inherit)',
        );
      }
      specInput.workstreams = effectiveWorkstreams;
      if (focusedWorkstreams !== undefined) {
        specInput.focusedWorkstreams = focusedWorkstreams;
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(TOPIC_KIND, specInput);
        docStatus = defaultStatus(TOPIC_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      const doc = store.createDocument({
        kind: TOPIC_KIND,
        slug,
        spec: validatedSpec,
        status: docStatus,
      });
      return asText(new Topic(doc));
    },
  );
}
