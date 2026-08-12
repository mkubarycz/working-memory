/**
 * `ws-config-create` — the Config kind's Create tool.
 *
 * One of the four tool files in the `config/` kind folder. Registered by the
 * folder's `index.ts` `registerApi` (which calls {@link registerWsConfigCreate});
 * result helpers come from `../toolResult.js` and the `Config` projection +
 * kind name from `./config.js`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Store } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { Config, CONFIG_KIND } from './config.js';

/**
 * Register the `ws-config-create` tool on an MCP session's server. The tool
 * speaks the configmap shape and is backed by generic `store` document ops for
 * kind `Config`, with the kind's own `validateSpec` gating the write (every
 * `data` value MUST be a string).
 */
export function registerWsConfigCreate(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-config-create',
    {
      title: 'Config: Create',
      description:
        'Create a Config (a "configmap": a named bag of string key-value pairs). Provide an ' +
        'optional `slug` (the registry key, e.g. "banking-app-developer"), an optional `name` ' +
        '(human label), the required `data` (an object of string→string pairs; may be empty), ' +
        'and an optional `status` (authored free-form). Every `data` value MUST be a string. The ' +
        'spec is validated against the Config kind. Returns the created config.',
      inputSchema: {
        slug: z.string().optional().describe('Optional registry-key slug (e.g. "banking-app-developer").'),
        name: z.string().optional().describe('Human-readable label (optional).'),
        data: z
          .record(z.string(), z.unknown())
          .describe('The key-value pairs (required, may be empty). All values MUST be strings.'),
        status: z.string().optional().describe('Authored free-form status (optional).'),
      },
    },
    async ({ slug, name, data, status }) => {
      const specInput: Record<string, unknown> = { data };
      if (name !== undefined) {
        specInput.name = name;
      }
      if (status !== undefined) {
        specInput.status = status;
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(CONFIG_KIND, specInput);
        docStatus = defaultStatus(CONFIG_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      const doc = store.createDocument({
        kind: CONFIG_KIND,
        slug,
        spec: validatedSpec,
        status: docStatus,
      });
      return asText(new Config(doc));
    },
  );
}
