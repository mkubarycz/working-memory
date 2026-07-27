/**
 * The `TopicType` kind — mirrors the dynamic `topic_types` registry
 * (schema/008_topic_types_table.sql + schema/013_topic_type_body_template.sql)
 * as a control-plane document. Topic subtypes ('topic', 'feature', 'task', …)
 * are runtime config in the extension; here each registry row lives as a
 * TopicType document so the same subtypes are expressible as documents.
 *
 * Column → field placement (migrations 008 + 013):
 *   - `id`            → `metadata.slug`   (the registry key, a string PK)
 *   - `created_at`    → `metadata.createdAt`
 *   - `updated_at`    → `metadata` timestamp
 *   - `label`         → spec (authored, NOT NULL)
 *   - `icon`          → spec (authored, NOT NULL — a codicon id)
 *   - `description`   → spec (authored, NOT NULL)
 *   - `body_template` → spec (authored, NOT NULL DEFAULT '' — the markdown
 *                        scaffold; empty string = verbatim store)
 *
 * No envelope `status` schema → inherits Base's empty `{}` status. TopicType is
 * authored config, not controller-driven — nothing writes an envelope status.
 *
 * Like the Workstream kind, TopicType self-registers its own namespaced domain
 * API (`ws-topictype-*`) via `registerApi` — the four tools live in sibling
 * `create` / `read` / `update` / `delete` files; `registerApi` wires them together.
 *
 * Drop-in discovered by `loader.ts`; no registration list to edit.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { TOPIC_TYPE_KIND } from './topictype.js';
import { registerWsTopicTypeCreate } from './create.js';
import { registerWsTopicTypeRead } from './read.js';
import { registerWsTopicTypeUpdate } from './update.js';
import { registerWsTopicTypeDelete } from './delete.js';

// Re-export the POCO interface so type consumers can import it from the kind
// entry point (mirrors the Workstream kind).
export type { ITopicType } from './topictype.js';

const topicType: KindModule = {
  name: TOPIC_TYPE_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // `label` — NOT NULL in migration 008; human-readable singular name.
        label: z.string().min(1),
        // `icon` — NOT NULL in migration 008; a VS Code codicon id.
        icon: z.string().min(1),
        // `description` — NOT NULL in migration 008; one-sentence semantics.
        description: z.string().min(1),
        // `body_template` — NOT NULL DEFAULT '' in migration 013; markdown
        // scaffold. Empty default preserves the verbatim-store behaviour.
        body_template: z.string().default(''),
      })
      .strict(),
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    fts: (r) => `${r.spec.label}\n${r.spec.description}`,
  },
  // The TopicType domain API (`ws-topictype-*`) — the four tools live in sibling
  // `create` / `read` / `update` / `delete` files; `registerApi` wires them together.
  registerApi: registerTopicTypeApi,
};

/**
 * Register the TopicType domain API (`ws-topictype-*`) on an MCP session's
 * server by wiring the four split tool files. Each tool lives in its own sibling
 * file (`create` / `read` / `update` / `delete`) in this kind folder and shares
 * the kind name + `TopicType` projection via `./topictype.js` and the result
 * helpers via `../toolResult.js`. TopicType has a registry-key `slug` (e.g.
 * 'feature'), so read/update/delete key on `slug`. Mirrors the Workstream kind
 * exactly.
 */
function registerTopicTypeApi(server: McpServer, store: Store): void {
  registerWsTopicTypeCreate(server, store);
  registerWsTopicTypeRead(server, store);
  registerWsTopicTypeUpdate(server, store);
  registerWsTopicTypeDelete(server, store);
}

export default topicType;
