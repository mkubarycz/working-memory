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
import { topicSpecWithDefaults, validateTopicReferences } from './references.js';

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
        'Create a Topic. Provide a `title` (required, ≤120 chars); optional `body`, ' +
        "`status` ('open' | 'closed', default 'open'), `topicType` (TopicType document ID), `parents` " +
        '(parent topic IDs), `workstreams` (member workstream IDs), and `focusedWorkstreams` ' +
        '(subset of `workstreams` this topic is pinned/focused in). Topics may remain unassigned ' +
        'when no workstream is supplied. Omitted `topicType` resolves the single live TopicType ' +
        'with spec.label equal to "Topic"; missing or ambiguous defaults are rejected. The spec is validated ' +
        'against the Topic kind (invalid status rejected). Returns the created topic.',
      inputSchema: z.object({
        title: z.string().describe('Topic title (required, 1–120 chars).'),
        body: z.string().optional().describe('Topic body (markdown).'),
        status: z
          .string()
          .optional()
          .describe("Authored status: 'open' | 'closed' (default 'open')."),
        topicType: z.string().min(1).optional().describe('TopicType document ID. Defaults to the unique live type with spec.label "Topic".'),
        parents: z.array(z.string().min(1)).optional().describe('Parent topic IDs.'),
        workstreams: z
          .array(z.string())
          .optional()
          .describe(
            'Member workstream IDs (topic membership). ' +
              "When omitted and `parents` are given, the topic inherits the parents' workstreams. " +
              'Otherwise omission creates an unassigned topic.',
          ),
        focusedWorkstreams: z
          .array(z.string())
          .optional()
          .describe('Subset of `workstreams` this topic is focused/pinned in.'),
      }).strict(),
    },
    async ({ title, body, status, topicType, parents, workstreams, focusedWorkstreams }) => {
      const specInput: Record<string, unknown> = { title };
      if (body !== undefined) {
        specInput.body = body;
      }
      if (status !== undefined) {
        specInput.status = status;
      }
      if (topicType !== undefined) specInput.topicType = topicType;
      if (parents !== undefined) {
        specInput.parents = parents;
      }
      // Workstream membership resolution (before schema validation):
      //   - explicit non-empty `workstreams` → use as-is.
      //   - none supplied but `parents` given → inherit the UNION of those
      //     parents' current `workstreams` (resolve each parent ID via store).
      //   - still empty after that → persist an unassigned topic.
      const suppliedWorkstreams = workstreams ?? [];
      let effectiveWorkstreams = suppliedWorkstreams;
      if (effectiveWorkstreams.length === 0 && parents !== undefined && parents.length > 0) {
        const inherited = new Set<string>();
        for (const parentId of parents) {
          const parentDoc = store.getDocument({ id: parentId, kind: TOPIC_KIND });
          if (!parentDoc) return asError(`Unknown parent topic ID: "${parentId}".`);
          for (const ws of stringArray(parentDoc.spec?.workstreams)) {
            inherited.add(ws);
          }
        }
        effectiveWorkstreams = [...inherited];
      }
      specInput.workstreams = effectiveWorkstreams;
      if (focusedWorkstreams !== undefined) {
        specInput.focusedWorkstreams = focusedWorkstreams;
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(TOPIC_KIND, topicSpecWithDefaults(store, specInput));
        validateTopicReferences(store, validatedSpec);
        docStatus = defaultStatus(TOPIC_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      const doc = store.createDocument({
        kind: TOPIC_KIND,
        spec: validatedSpec,
        status: docStatus,
      });
      return asText(new Topic(doc));
    },
  );
}
