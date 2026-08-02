/**
 * The `Topic` kind — mirrors the extension's existing topics
 * (slug + title + body + open|closed + topic_type) as a control-plane document,
 * PLUS workstream membership modeled as a spec ref (`workstreams`: an array of
 * workstream slugs) rather than a separate edges table.
 *
 * Drop-in discovered by `loader.ts`; no registration list to edit.
 *
 * NOTE on the two "status" concepts (they are DISTINCT):
 *   - `spec.status` (below) is an AUTHORED open|closed field — human/agent
 *     input, part of desired state. It mirrors the existing topics.status
 *     column, so it keeps the name `status`.
 *   - The envelope `status` (controller-owned, observed state) is intentionally
 *     OMITTED from this descriptor, so Topic inherits Base's empty `{}` status.
 *     Topic is content, not controller-driven — nothing writes an envelope
 *     status for it.
 * Kept the spec field named `status` (not `state`) to mirror existing topics
 * one-to-one; the dual name is disambiguated by this comment and by the fact
 * that the envelope status stays Base's empty object.
 *
 * Like the Workstream kind, Topic self-registers its own namespaced domain API
 * (`ws-topic-*`) via `registerApi` — the four tools live in sibling
 * `create` / `read` / `update` / `delete` files; `registerApi` wires them together.
 * Workstream membership + parent links are ORDINARY SPEC FIELDS
 * (`spec.workstreams`, `spec.parents`), so `ws-topic-update` fully edits them —
 * there are no bespoke attach/detach tools. "Which topics belong to a
 * workstream" is answered by `ws-topic-read { workstream }`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import type { Store } from '../../store.js';
import { TOPIC_KIND } from './topic.js';
import { registerWsTopicCreate } from './create.js';
import { registerWsTopicRead } from './read.js';
import { registerWsTopicUpdate } from './update.js';
import { registerWsTopicDelete } from './delete.js';

// Re-export the POCO interface + status type so type consumers can import them
// from the kind entry point (mirrors the Workstream/TopicType kinds).
export type { ITopic, TopicSpecStatus } from './topic.js';

const topic: KindModule = {
  name: TOPIC_KIND,
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // Required + capped: the validation demo (limit is tunable).
        title: z.string().min(1).max(120),
        body: z.string().default(''),
        // AUTHORED open/closed — a SPEC field, NOT the controller-owned envelope
        // status (which Topic inherits empty from Base).
        status: z.enum(['open', 'closed']).default('open'),
        topicType: z.string().default('topic'),
        // Parent topic slugs. NOTE: `parents` will migrate to `parent-of` edges
        // once the edges table lands.
        parents: z.array(z.string()).default([]),
        // Workstream MEMBERSHIP as a spec ref: the slugs of the workstreams this
        // topic belongs to. Modeled here (not as a separate edges table) so
        // "topics of a workstream" is a `ws-topic-read { workstream }` filter and
        // membership edits are ordinary `ws-topic-update` spec patches.
        // REQUIRED to be non-empty: every topic must belong to ≥1 workstream.
        // `ws-topic-create` inherits the union of `parents`' workstreams when the
        // caller supplies none; the guard here rejects a topic that would end up
        // orphaned (no parents to inherit from, no explicit membership).
        workstreams: z.array(z.string()).min(1, 'a topic must belong to at least one workstream'),
        // Per-workstream FOCUS pin as a spec ref: the subset of `workstreams`
        // for which this topic is focused/pinned. A workstream's focused topics =
        // topics whose `focusedWorkstreams` includes that workstream's slug.
        // Symmetric with `workstreams`; edited via ordinary `ws-topic-update`.
        focusedWorkstreams: z.array(z.string()).default([]),
      })
      .strict(),
    validateMetadata: ({ slug, store, excludeId }) => {
      const slugConvention =
        'A Topic requires a unique slug: lowercase words separated with dashes ' +
        '(best practice: 3-5 words, short and precise).';
      if (typeof slug !== 'string' || slug.trim() === '' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(slug)) {
        throw new Error(slugConvention);
      }
      const existing = store.getDocument({ slug, kind: TOPIC_KIND });
      if (existing && existing.metadata.id !== excludeId) {
        throw new Error(`${slugConvention} "${slug}" is already in use.`);
      }
    },
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    fts: (r) => `${r.spec.title}\n${r.spec.body}`,
  },
  // The Topic domain API (`ws-topic-*`) — the four tools live in sibling
  // `create` / `read` / `update` / `delete` files; `registerApi` wires them together.
  registerApi: registerTopicApi,
};

/**
 * Register the Topic domain API (`ws-topic-*`) on an MCP session's server by
 * wiring the four split tool files. Each tool lives in its own sibling file
 * (`create` / `read` / `update` / `delete`) in this kind folder and shares the
 * kind name + `Topic` projection via `./topic.js` and the result helpers via
 * `../toolResult.js`. This is the "kind is a plugin" surface: schema +
 * validation + the `ws-topic-*` API all belong to this one kind — just split
 * across files in one folder, mirroring the Workstream kind exactly.
 */
function registerTopicApi(server: McpServer, store: Store): void {
  registerWsTopicCreate(server, store);
  registerWsTopicRead(server, store);
  registerWsTopicUpdate(server, store);
  registerWsTopicDelete(server, store);
}

export default topic;
