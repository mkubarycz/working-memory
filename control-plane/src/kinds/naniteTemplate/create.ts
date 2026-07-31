/**
 * `ws-nanitetemplate-create` — the NaniteTemplate kind's Create tool.
 *
 * One of the four tool files in the `naniteTemplate/` kind folder. Registered by
 * the folder's `index.ts` `registerApi`. Mirrors `ws-topic-create` exactly
 * (slug-based identity).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { NaniteTemplate, NANITE_TEMPLATE_KIND } from './naniteTemplate.js';

/**
 * Register the `ws-nanitetemplate-create` tool. Creates a Nanite Template (the
 * reusable definition of a headless subagent). Backed by generic `store`
 * document ops for kind `NaniteTemplate`, with the kind's own `validateSpec`
 * gating the write.
 */
export function registerWsNaniteTemplateCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-nanitetemplate-create',
    {
      title: 'Nanite Template: Create',
      description:
        'Create a Nanite Template (the reusable DEFINITION of a headless subagent). Provide a ' +
        '`title` (required); optional `slug`, `triggerPhrase`, `instructions`, `executionSettings` ' +
        '(model + tuning object), `toolAllowlist` (allowed tool names; `*` = all available), `toolDenylist` ' +
        '(names the nanite may never use), `inputSchema`/`outputSchema` ' +
        '(typed JSON schemas), `acceptanceCriteria`, `acceptanceThreshold` (0-100, default 60), and ' +
        '`enabled` (default true). Instantiate a template into a running Nanite with ws-nanite-create. ' +
        'Returns the created template.',
      inputSchema: {
        slug: z.string().optional().describe('Optional human-friendly slug for the template.'),
        title: z.string().describe('Template title (required, 1–200 chars).'),
        triggerPhrase: z.string().optional().describe('Phrase that triggers this template.'),
        instructions: z.string().optional().describe('System/instruction prompt for the subagent.'),
        executionSettings: z
          .record(z.string(), z.unknown())
          .optional()
          .describe('Model + tuning knobs (open object).'),
        toolAllowlist: z.array(z.string()).optional().describe('Allow-listed tool names (`*` = all available).'),
        toolDenylist: z.array(z.string()).optional().describe('Tool names the nanite may never use (subtracted from the allow-list).'),
        allowRunWithoutHuman: z
          .boolean()
          .optional()
          .describe('Allow unattended dispatch (no human approval). Default false.'),
        inputSchema: z.record(z.string(), z.unknown()).optional().describe('Typed input JSON schema.'),
        outputSchema: z.record(z.string(), z.unknown()).optional().describe('Typed output JSON schema.'),
        acceptanceCriteria: z.string().optional().describe('Acceptance rubric (human-written).'),
        acceptanceThreshold: z
          .number()
          .optional()
          .describe('Minimum acceptance confidence 0-100 (default 60).'),
        enabled: z.boolean().optional().describe('Whether the template is enabled (default true).'),
      },
    },
    async (input) => {
      const { slug, ...rest } = input;
      const specInput: Record<string, unknown> = { title: rest.title };
      for (const key of [
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
          specInput[key] = rest[key];
        }
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(NANITE_TEMPLATE_KIND, specInput);
        docStatus = defaultStatus(NANITE_TEMPLATE_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      const doc = store.createDocument({
        kind: NANITE_TEMPLATE_KIND,
        slug,
        spec: validatedSpec,
        status: docStatus,
      });
      return asText(new NaniteTemplate(doc));
    },
  );
}
