/**
 * The `Config` kind — a "configmap": a named bag of string key-value pairs
 * (`data`) plus an optional human `name` and authored `status`, identified by a
 * registry-key `slug` (e.g. `banking-app-developer`). A nanite references
 * configmaps by slug/id and, on run, their merged `data` is injected into its
 * dev container as environment variables (so e.g. a `GH_TOKEN` key reaches the
 * container).
 *
 * `data` values are ALWAYS strings — the spec schema rejects a non-string value
 * outright. `data` is required (an empty object is allowed). Unknown top-level
 * spec fields are rejected (`.strict()`).
 *
 * No envelope `status` schema → inherits Base's empty `{}` status. `spec.status`
 * is an AUTHORED free-form string, not a controller-written envelope status.
 *
 * Like the TopicType kind, Config self-registers its own namespaced domain API
 * (`ws-config-*`) via `registerApi` — the four tools live in sibling
 * `create` / `read` / `update` / `delete` files; `registerApi` wires them together.
 *
 * Drop-in discovered by `loader.ts`; no registration list to edit.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { CONFIG_KIND } from './config.js';
import { registerWsConfigCreate } from './create.js';
import { registerWsConfigRead } from './read.js';
import { registerWsConfigUpdate } from './update.js';
import { registerWsConfigDelete } from './delete.js';

// Re-export the POCO interface so type consumers can import it from the kind
// entry point (mirrors the TopicType kind).
export type { IConfig } from './config.js';

const config: KindModule = {
  name: CONFIG_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // `name` — optional human label.
        name: z.string().optional(),
        // `data` — REQUIRED (may be empty). Every value MUST be a string; a
        // non-string value is rejected. Values may be secrets (e.g. a token).
        data: z.record(z.string(), z.string()),
        // `status` — optional authored free-form string (NOT an envelope status).
        status: z.string().optional(),
      })
      .strict(),
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    // FTS projects the slug + name + the data KEYS only — NEVER the values,
    // which may be secrets.
    fts: (r) =>
      [
        r.metadata.slug,
        r.spec.name,
        ...Object.keys((r.spec.data as Record<string, unknown> | undefined) ?? {}),
      ]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n'),
  },
  // The Config domain API (`ws-config-*`) — the four tools live in sibling
  // `create` / `read` / `update` / `delete` files; `registerApi` wires them together.
  registerApi: registerConfigApi,
};

/**
 * Register the Config domain API (`ws-config-*`) on an MCP session's server by
 * wiring the four split tool files. Each tool lives in its own sibling file
 * (`create` / `read` / `update` / `delete`) in this kind folder and shares the
 * kind name + `Config` projection via `./config.js` and the result helpers via
 * `../toolResult.js`. Config has a registry-key `slug` (e.g.
 * 'banking-app-developer'), so read/update/delete key on `slug`. Mirrors the
 * TopicType kind exactly.
 */
function registerConfigApi(server: McpServer, store: Store): void {
  registerWsConfigCreate(server, store);
  registerWsConfigRead(server, store);
  registerWsConfigUpdate(server, store);
  registerWsConfigDelete(server, store);
}

export default config;
