/**
 * The `NaniteTemplate` kind — the reusable DEFINITION of a headless subagent,
 * modeled as a control-plane document. Mirrors the field shape of the old
 * pre-control-plane `nanites` table (schema/018_nanites.sql +
 * schema/019_nanite_acceptance.sql), renamed: the OLD model called this a
 * "Nanite"; the NEW model calls the definition a **Nanite Template** and the
 * execution instance a {@link Nanite}.
 *
 * Drop-in discovered by `loader.ts`; no registration list to edit. Self-registers
 * its own namespaced domain API (`ws-nanitetemplate-*`) via `registerApi` — the
 * four CRUD tools live in sibling `create` / `read` / `update` / `delete` files.
 * Like Topic, identity is a human `slug`.
 *
 * No envelope `status` schema → inherits Base's empty `{}` status (a template is
 * a definition, not a controller-driven resource).
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { NANITE_TEMPLATE_KIND } from './naniteTemplate.js';
import { registerWsNaniteTemplateCreate } from './create.js';
import { registerWsNaniteTemplateRead } from './read.js';
import { registerWsNaniteTemplateUpdate } from './update.js';
import { registerWsNaniteTemplateDelete } from './delete.js';

// Re-export the POCO interface so type consumers can import it from the kind
// entry point (mirrors the Topic/Alert kinds).
export type { INaniteTemplate } from './naniteTemplate.js';

const naniteTemplate: KindModule = {
  name: NANITE_TEMPLATE_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // The template's friendly name (required).
        title: z.string().min(1).max(200),
        // The phrase that triggers this template (018 `trigger_phrase`).
        triggerPhrase: z.string().default(''),
        // The system/instruction prompt handed to the subagent (018 NOT NULL).
        instructions: z.string().default(''),
        // Model + tuning knobs — an open object (018 carried a single `model`).
        executionSettings: z.record(z.string(), z.unknown()).default({}),
        // Allow-listed tool names the runner may expose (018 `tool_allowlist`).
        toolAllowlist: z.array(z.string()).default([]),
        toolDenylist: z.array(z.string()).default([]),
        // When true, a nanite from this template may be dispatched WITHOUT
        // human approval (an agent/parent may enqueue it). Default false.
        allowRunWithoutHuman: z.boolean().default(false),
        // Typed input / output JSON schemas (018 `input_schema` / `output_schema`).
        inputSchema: z.record(z.string(), z.unknown()).default({}),
        outputSchema: z.record(z.string(), z.unknown()).default({}),
        // Acceptance rubric + minimum confidence 0-100 (019).
        acceptanceCriteria: z.string().default(''),
        acceptanceThreshold: z.number().int().min(0).max(100).default(60),
        // Whether the template is enabled (018 `enabled`).
        enabled: z.boolean().default(true),
      })
      .strict(),
    fts: (r) => `${r.spec.title}\n${r.spec.triggerPhrase}\n${r.spec.instructions}`,
  },
  registerApi: registerNaniteTemplateApi,
};

/**
 * Register the NaniteTemplate domain API (`ws-nanitetemplate-*`) on an MCP
 * session's server by wiring the four split tool files. Mirrors the Topic kind.
 */
function registerNaniteTemplateApi(server: McpServer, store: Store): void {
  registerWsNaniteTemplateCreate(server, store);
  registerWsNaniteTemplateRead(server, store);
  registerWsNaniteTemplateUpdate(server, store);
  registerWsNaniteTemplateDelete(server, store);
}

export default naniteTemplate;
