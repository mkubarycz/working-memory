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
 * Drop-in discovered by `loader.ts`; no registration list to edit.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import { type Store, ConflictError, NotFoundError } from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { TopicType } from './topictype.js';

/** The TopicType kind name in the control-plane registry. */
const TOPIC_TYPE_KIND = 'TopicType';

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
  // The TopicType domain API (`ws-topictype-*`) — schema + validation + API
  // co-located, mirroring the Topic/Workstream kinds.
  registerApi: registerTopicTypeApi,
};

/**
 * Register the TopicType domain API (`ws-topictype-*`) on an MCP session's
 * server. Each tool speaks the legacy topic-type shape and is backed by generic
 * `store` document ops for kind `TopicType`, with the kind's own `validateSpec`
 * gating writes (so an invalid spec is rejected as kind validation, not a raw
 * store error). TopicType has a registry-key `slug` (e.g. 'feature'), so — like
 * Workstream/Topic — read/update/delete key on `slug`.
 */
function registerTopicTypeApi(server: McpServer, store: Store): void {
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

  server.registerTool(
    'ws-topictype-read',
    {
      title: 'TopicType: Read',
      description:
        'Read one TopicType or many. Read ONE by `slug` or `id`; otherwise LIST all TopicTypes ' +
        '(newest-first), with an optional `query` case-insensitive substring filter and a `limit`. ' +
        'ALWAYS returns { count, topicTypes } — a by-slug/id read yields a 0-or-1 element list, so ' +
        'callers get one uniform shape.',
      inputSchema: {
        slug: z.string().optional().describe('Read ONE topic type by slug (registry key).'),
        id: z.string().optional().describe('Read ONE topic type by document id (uuid).'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter over topic-type text (list mode only).'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max topic types to return (list mode only).'),
      },
    },
    async ({ slug, id, query, limit }) => {
      // Single read: by id or slug. A foreign-kind id maps to nothing (the
      // `ws-topictype-*` API only speaks TopicTypes).
      if (id !== undefined || slug !== undefined) {
        const doc = store.getDocument({ id, slug, kind: TOPIC_TYPE_KIND });
        const topicTypes = doc && doc.kind === TOPIC_TYPE_KIND ? [new TopicType(doc)] : [];
        return asText({ count: topicTypes.length, topicTypes });
      }
      // List mode: all live TopicTypes, optional substring query + limit.
      let docs = store.listDocuments({ kind: TOPIC_TYPE_KIND });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, topicTypes: docs.map((d) => new TopicType(d)) });
    },
  );

  server.registerTool(
    'ws-topictype-update',
    {
      title: 'TopicType: Update',
      description:
        'Update a TopicType identified by `slug`. Pass only the fields you are changing (`label`, ' +
        '`icon`, `description`, `body_template`). Reads the current document for its id + ' +
        'resourceVersion, then does a compare-and-swap write of the merged, re-validated spec. ' +
        'Unknown slug and version conflicts are surfaced clearly. Returns the updated topic type.',
      inputSchema: {
        slug: z.string().describe('Slug of the topic type to update (required).'),
        label: z.string().optional().describe('New label.'),
        icon: z.string().optional().describe('New codicon id.'),
        description: z.string().optional().describe('New description.'),
        body_template: z.string().optional().describe('New body template.'),
      },
    },
    async ({ slug, label, icon, description, body_template }) => {
      const existing = store.getDocument({ slug, kind: TOPIC_TYPE_KIND });
      if (!existing) {
        return asError(`Unknown topic type slug: "${slug}". No live topic type with that slug.`);
      }
      const patch: Record<string, unknown> = {};
      if (label !== undefined) {
        patch.label = label;
      }
      if (icon !== undefined) {
        patch.icon = icon;
      }
      if (description !== undefined) {
        patch.description = description;
      }
      if (body_template !== undefined) {
        patch.body_template = body_template;
      }
      if (Object.keys(patch).length === 0) {
        // Nothing to change: return the current mapped topic type rather than a
        // no-op CAS write.
        return asText(new TopicType(existing));
      }
      let validatedSpec: Record<string, unknown>;
      try {
        // Merge the patch onto the current spec, then re-validate the whole spec.
        validatedSpec = validateSpec(TOPIC_TYPE_KIND, { ...existing.spec, ...patch });
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec: validatedSpec,
        });
        return asText(new TopicType(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: topic type "${slug}" changed since it was read (current resourceVersion ` +
              `${err.currentResourceVersion}). Re-read with ws-topictype-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(
            `Unknown topic type slug: "${slug}". It no longer exists (it may have been deleted).`,
          );
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'ws-topictype-delete',
    {
      title: 'TopicType: Delete',
      description:
        'Soft-delete a TopicType by `slug` (it drops out of ws-topictype-read). To undelete, call ' +
        'with `restore: true`. Unknown/already-deleted slug (or an already-live slug on restore) ' +
        'is rejected. Returns { ok, slug }.',
      inputSchema: {
        slug: z.string().describe('Slug of the topic type to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted topic type instead of deleting.'),
      },
    },
    async ({ slug, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({
        slug,
        kind: TOPIC_TYPE_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== TOPIC_TYPE_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted topic type with slug "${slug}" to restore.`
            : `Unknown topic type slug: "${slug}". No live topic type with that slug.`,
        );
      }
      try {
        if (restore === true) {
          store.restoreDocument({ id: doc.metadata.id });
        } else {
          store.deleteDocument({ id: doc.metadata.id });
        }
        return asText({ ok: true, slug });
      } catch (err) {
        if (err instanceof NotFoundError) {
          return asError(
            restore === true
              ? `No soft-deleted topic type with slug "${slug}" to restore.`
              : `Unknown or already-deleted topic type slug: "${slug}".`,
          );
        }
        throw err;
      }
    },
  );
}

export default topicType;
