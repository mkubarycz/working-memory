/**
 * `ws-nanite-create` — the Nanite kind's Create tool.
 *
 * Creates ONE execution instance of a Nanite Template. REQUIRES an owning
 * `workstream` (a live Workstream slug) and an input `inputTopic` (a live Topic
 * slug) — both immutable at creation. The new Nanite starts in phase `Pending`;
 * kick it off with `ws-nanite-run`. Nanites have no slug (identity is the
 * store-assigned uuid), like the Alert kind.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { Nanite, NANITE_KIND } from './nanite.js';

/** Register the `ws-nanite-create` tool. */
export function registerWsNaniteCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanite-create',
    {
      title: 'Nanite: Create',
      description:
        'Create a Nanite — ONE execution instance. REQUIRES `workstream` (a live workstream slug ' +
        'that owns it) and `inputTopic` (a live topic slug — the topic IS the input); both are ' +
        'immutable at creation. Optional `templateId` (owning Nanite Template) and `request` ' +
        '(free-text prompt). The Nanite starts Pending and renders as a child row under its input ' +
        'topic in the panel; run it with ws-nanite-run. Returns the created nanite.',
      inputSchema: {
        workstream: z.string().describe('Owning workstream slug (required, immutable).'),
        inputTopic: z.string().describe('Input topic slug — the topic IS the input (required, immutable).'),
        templateId: z.string().optional().describe('Owning Nanite Template slug/id (optional).'),
        request: z.string().optional().describe('Free-text request/prompt for this execution.'),
      },
    },
    async ({ workstream, inputTopic, templateId, request }) => {
      // Validate the owning refs exist so the Nanite renders under a real topic
      // in a real workstream (mirrors the topic-membership guard in
      // ws-topic-create). Both are live-only lookups.
      const wsDoc = store.getDocument({ slug: workstream, kind: 'Workstream' });
      if (!wsDoc) {
        return asError(`Unknown workstream slug: "${workstream}". Create it first.`);
      }
      const topicDoc = store.getDocument({ slug: inputTopic, kind: 'Topic' });
      if (!topicDoc) {
        return asError(`Unknown input topic slug: "${inputTopic}". Create it first.`);
      }
      const specInput: Record<string, unknown> = { workstream, inputTopic };
      if (templateId !== undefined) {
        specInput.templateId = templateId;
      }
      if (request !== undefined) {
        specInput.request = request;
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(NANITE_KIND, specInput);
        docStatus = defaultStatus(NANITE_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      const doc = store.createDocument({ kind: NANITE_KIND, spec: validatedSpec, status: docStatus });
      return asText(new Nanite(doc));
    },
  );
}
