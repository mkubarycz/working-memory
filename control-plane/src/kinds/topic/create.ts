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
import { Topic, TOPIC_KIND } from './topic.js';

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
        '(parent topic slugs), and `workstreams` (member workstream slugs). The spec is validated ' +
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
          .describe('Member workstream slugs (topic membership).'),
      },
    },
    async ({ slug, title, body, status, topicType, parents, workstreams }) => {
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
      if (workstreams !== undefined) {
        specInput.workstreams = workstreams;
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
