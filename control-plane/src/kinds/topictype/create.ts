/**
 * `ws-topictype-create` — the TopicType kind's Create tool.
 *
 * One of the four tool files in the `topictype/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsTopicTypeCreate});
 * result helpers come from `../toolResult.js` and the `TopicType` projection +
 * kind name from `./topictype.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { TopicType, TOPIC_TYPE_KIND } from './topictype.js';

/**
 * Register the `ws-topictype-create` tool on an MCP session's server. The tool
 * speaks the legacy topic-type shape and is backed by generic `store` document
 * ops for kind `TopicType`, with the kind's own `validateSpec` gating the write.
 */
export function registerWsTopicTypeCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topictype-create',
    {
      title: 'TopicType: Create',
      description:
        'Create a TopicType (a topic subtype like "feature" or "task"). Provide an optional `slug` ' +
        '(the registry key), a `label` (required), an `icon` (required, a codicon id), a ' +
        '`description` (required), and an optional `body_template` (markdown scaffold, default ' +
        'empty). The spec is validated against the TopicType kind. Returns the created topic type.',
      inputSchema: {
        slug: z.string().optional().describe('Optional registry-key slug (e.g. "feature").'),
        label: z.string().describe('Human-readable singular label (required).'),
        icon: z.string().describe('VS Code codicon id (required).'),
        description: z.string().describe('One-sentence semantics (required).'),
        body_template: z
          .string()
          .optional()
          .describe('Markdown body scaffold for topics of this type (default empty).'),
      },
    },
    async ({ slug, label, icon, description, body_template }) => {
      const specInput: Record<string, unknown> = { label, icon, description };
      if (body_template !== undefined) {
        specInput.body_template = body_template;
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(TOPIC_TYPE_KIND, specInput);
        docStatus = defaultStatus(TOPIC_TYPE_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      const doc = store.createDocument({
        kind: TOPIC_TYPE_KIND,
        slug,
        spec: validatedSpec,
        status: docStatus,
      });
      return asText(new TopicType(doc));
    },
  );
}
