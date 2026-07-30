/**
 * `ws-nanite-create` — the Nanite kind's Create tool.
 *
 * Creates ONE execution instance of a Nanite Template. REQUIRES an owning
 * `workstream` (a live Workstream slug). `inputTopic` (a live Topic slug) is
 * OPTIONAL — when set, the topic IS the input; when omitted the Nanite runs
 * workstream-wide. Both refs are immutable at creation. The new Nanite starts
 * in phase `Pending`; kick it off with `ws-nanite-run`. Nanites have no slug
 * (identity is the store-assigned uuid), like the Alert kind.
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
        'that owns it). `inputTopic` (a live topic slug — the topic IS the input) is OPTIONAL: omit ' +
        'it to run the Nanite workstream-wide. Both refs are immutable at creation. Optional ' +
        '`templateId` (owning Nanite Template) and `request` (free-text prompt). The Nanite starts ' +
        'Pending and renders under its input topic (or in the workstream-card Nanites group when ' +
        'topic-less); run it with ws-nanite-run. Returns the created nanite.',
      inputSchema: {
        workstream: z.string().describe('Owning workstream slug (required, immutable).'),
        inputTopic: z
          .string()
          .optional()
          .describe('Input topic slug — the topic IS the input (optional; omit to run workstream-wide, immutable).'),
        templateId: z.string().optional().describe('Owning Nanite Template slug/id (optional).'),
        request: z.string().optional().describe('Free-text request/prompt for this execution.'),
      },
    },
    async ({ workstream, inputTopic, templateId, request }) => {
      // Validate the owning workstream exists so the Nanite renders under a
      // real workstream (mirrors the topic-membership guard in
      // ws-topic-create). The input topic, when supplied, must also be live.
      const wsDoc = store.getDocument({ slug: workstream, kind: 'Workstream' });
      if (!wsDoc) {
        return asError(`Unknown workstream slug: "${workstream}". Create it first.`);
      }
      if (inputTopic !== undefined && inputTopic !== '') {
        const topicDoc = store.getDocument({ slug: inputTopic, kind: 'Topic' });
        if (!topicDoc) {
          return asError(`Unknown input topic slug: "${inputTopic}". Create it first.`);
        }
      }
      const specInput: Record<string, unknown> = { workstream };
      if (inputTopic !== undefined) {
        specInput.inputTopic = inputTopic;
      }
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
