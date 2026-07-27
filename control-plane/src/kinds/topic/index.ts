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
 * (`ws-topic-*`) via `registerApi`, co-located with the schema + validation + the
 * document↔domain projection (`Topic` POCO). Workstream membership is a SPEC REF,
 * not an edges table: `ws-topic-attach-workstream` / `ws-topic-detach-workstream`
 * add/remove a workstream slug in `spec.workstreams` (idempotent), so "which
 * topics belong to a workstream" is answered by `ws-topic-read { workstream }`.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Base, type KindModule } from '../base.js';
import {
  type Store,
  type DocumentEnvelope,
  ConflictError,
  NotFoundError,
} from '../../store.js';
import { validateSpec, defaultStatus } from '../registry.js';
import { asText, asError } from '../toolResult.js';
import { Topic, stringArray } from './topic.js';

/** The Topic kind name in the control-plane registry. */
const TOPIC_KIND = 'Topic';

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
        // attach/detach are idempotent spec patches.
        workstreams: z.array(z.string()).default([]),
      })
      .strict(),
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    fts: (r) => `${r.spec.title}\n${r.spec.body}`,
  },
  // The Topic domain API (`ws-topic-*`) — schema + validation + API co-located.
  registerApi: registerTopicApi,
};

/**
 * CAS-write a Topic's whole spec with a replaced `workstreams` array (the shared
 * tail of `ws-topic-attach-workstream` / `ws-topic-detach-workstream`). Re-validates
 * the merged spec and surfaces conflict / not-found clearly.
 */
function writeWorkstreamMembership(
  store: Store,
  existing: DocumentEnvelope,
  slug: string,
  nextWorkstreams: string[],
) {
  let validatedSpec: Record<string, unknown>;
  try {
    validatedSpec = validateSpec(TOPIC_KIND, { ...existing.spec, workstreams: nextWorkstreams });
  } catch (err) {
    return asError((err as Error).message);
  }
  try {
    const updated = store.updateDocument({
      id: existing.metadata.id,
      expectedResourceVersion: existing.metadata.resourceVersion,
      spec: validatedSpec,
    });
    return asText(new Topic(updated));
  } catch (err) {
    if (err instanceof ConflictError) {
      return asError(
        `Conflict: topic "${slug}" changed since it was read (current resourceVersion ` +
          `${err.currentResourceVersion}). Re-read with ws-topic-read and retry.`,
      );
    }
    if (err instanceof NotFoundError) {
      return asError(`Unknown topic slug: "${slug}". It no longer exists (it may have been deleted).`);
    }
    throw err;
  }
}

/**
 * Register the Topic domain API (`ws-topic-*`) on an MCP session's server. Each
 * tool speaks the legacy topic shape and is backed by generic `store` document
 * ops for kind `Topic`, with the kind's own `validateSpec` gating writes (so an
 * invalid status is rejected as kind validation, not a raw store error). This
 * is the "kind is a plugin" surface: schema + validation + the `ws-topic-*` API all
 * live in this one file, mirroring the Workstream kind exactly.
 */
function registerTopicApi(server: McpServer, store: Store): void {
  server.registerTool(
    'ws-topic-create',
    {
      title: 'Topic: Create',
      description:
        'Create a Topic. Provide a `title` (required, ≤120 chars); optional `slug`, `body`, ' +
        "`status` ('open' | 'closed', default 'open'), `topicType` (default 'topic'), `parents` " +
        '(parent topic slugs), and `workstreams` (member workstream slugs). The spec is validated ' +
        'against the Topic kind (invalid status rejected). Returns the created topic.',
      inputSchema: {
        slug: z.string().optional().describe('Optional human-friendly slug for the topic.'),
        title: z.string().describe('Topic title (required, 1–120 chars).'),
        body: z.string().optional().describe('Topic body (markdown).'),
        status: z
          .string()
          .optional()
          .describe("Authored status: 'open' | 'closed' (default 'open')."),
        topicType: z.string().optional().describe("Topic type discriminator (default 'topic')."),
        parents: z.array(z.string()).optional().describe('Parent topic slugs.'),
        workstreams: z
          .array(z.string())
          .optional()
          .describe('Member workstream slugs (topic membership).'),
      },
    },
    async ({ slug, title, body, status, topicType, parents, workstreams }) => {
      const specInput: Record<string, unknown> = { title };
      if (body !== undefined) {
        specInput.body = body;
      }
      if (status !== undefined) {
        specInput.status = status;
      }
      if (topicType !== undefined) {
        specInput.topicType = topicType;
      }
      if (parents !== undefined) {
        specInput.parents = parents;
      }
      if (workstreams !== undefined) {
        specInput.workstreams = workstreams;
      }
      let validatedSpec: Record<string, unknown>;
      let docStatus: Record<string, unknown>;
      try {
        validatedSpec = validateSpec(TOPIC_KIND, specInput);
        docStatus = defaultStatus(TOPIC_KIND);
      } catch (err) {
        return asError((err as Error).message);
      }
      const doc = store.createDocument({
        kind: TOPIC_KIND,
        slug,
        spec: validatedSpec,
        status: docStatus,
      });
      return asText(new Topic(doc));
    },
  );

  server.registerTool(
    'ws-topic-read',
    {
      title: 'Topic: Read',
      description:
        'Read one Topic or many. Read ONE by `slug` or `id`; otherwise LIST all Topics ' +
        '(newest-first), with an optional `query` case-insensitive substring filter, a ' +
        '`workstream` membership filter (topics whose `workstreams` include that slug), and a ' +
        '`limit`. ALWAYS returns { count, topics } — a by-slug/id read yields a 0-or-1 element ' +
        'list, so callers get one uniform shape.',
      inputSchema: {
        slug: z.string().optional().describe('Read ONE topic by slug.'),
        id: z.string().optional().describe('Read ONE topic by document id (uuid).'),
        query: z
          .string()
          .optional()
          .describe('Case-insensitive substring filter over topic text (list mode only).'),
        workstream: z
          .string()
          .optional()
          .describe('Filter to topics whose `workstreams` include this slug (list mode only).'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max topics to return (list mode only).'),
      },
    },
    async ({ slug, id, query, workstream, limit }) => {
      // Single read: by id or slug. A foreign-kind id maps to nothing (the
      // `ws-topic-*` API only speaks Topics).
      if (id !== undefined || slug !== undefined) {
        const doc = store.getDocument({ id, slug, kind: TOPIC_KIND });
        const topics = doc && doc.kind === TOPIC_KIND ? [new Topic(doc)] : [];
        return asText({ count: topics.length, topics });
      }
      // List mode: all live Topics, optional substring query + workstream
      // membership filter + limit.
      let docs = store.listDocuments({ kind: TOPIC_KIND });
      if (query !== undefined && query.trim() !== '') {
        const needle = query.toLowerCase();
        docs = docs.filter((d) => JSON.stringify(d).toLowerCase().includes(needle));
      }
      if (workstream !== undefined && workstream.trim() !== '') {
        docs = docs.filter((d) => stringArray(d.spec?.workstreams).includes(workstream));
      }
      if (limit !== undefined) {
        docs = docs.slice(0, limit);
      }
      return asText({ count: docs.length, topics: docs.map((d) => new Topic(d)) });
    },
  );

  server.registerTool(
    'ws-topic-update',
    {
      title: 'Topic: Update',
      description:
        'Update a Topic identified by `slug`. Pass only the fields you are changing (`title`, ' +
        '`body`, `status`, `topicType`, `parents`, `workstreams`). Reads the current document for ' +
        'its id + resourceVersion, then does a compare-and-swap write of the merged, re-validated ' +
        'spec. Unknown slug and version conflicts are surfaced clearly. Returns the updated topic.',
      inputSchema: {
        slug: z.string().describe('Slug of the topic to update (required).'),
        title: z.string().optional().describe('New title (≤120 chars).'),
        body: z.string().optional().describe('New body.'),
        status: z.string().optional().describe("New status: 'open' | 'closed'."),
        topicType: z.string().optional().describe('New topic type.'),
        parents: z.array(z.string()).optional().describe('Replacement parent topic slugs.'),
        workstreams: z
          .array(z.string())
          .optional()
          .describe('Replacement member workstream slugs.'),
      },
    },
    async ({ slug, title, body, status, topicType, parents, workstreams }) => {
      const existing = store.getDocument({ slug, kind: TOPIC_KIND });
      if (!existing) {
        return asError(`Unknown topic slug: "${slug}". No live topic with that slug.`);
      }
      const patch: Record<string, unknown> = {};
      if (title !== undefined) {
        patch.title = title;
      }
      if (body !== undefined) {
        patch.body = body;
      }
      if (status !== undefined) {
        patch.status = status;
      }
      if (topicType !== undefined) {
        patch.topicType = topicType;
      }
      if (parents !== undefined) {
        patch.parents = parents;
      }
      if (workstreams !== undefined) {
        patch.workstreams = workstreams;
      }
      if (Object.keys(patch).length === 0) {
        // Nothing to change: return the current mapped topic rather than a no-op
        // CAS write.
        return asText(new Topic(existing));
      }
      let validatedSpec: Record<string, unknown>;
      try {
        // Merge the patch onto the current spec, then re-validate the whole spec
        // (invalid status rejected as kind validation). Persist the parsed value.
        validatedSpec = validateSpec(TOPIC_KIND, { ...existing.spec, ...patch });
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        const updated = store.updateDocument({
          id: existing.metadata.id,
          expectedResourceVersion: existing.metadata.resourceVersion,
          spec: validatedSpec,
        });
        return asText(new Topic(updated));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: topic "${slug}" changed since it was read (current resourceVersion ` +
              `${err.currentResourceVersion}). Re-read with ws-topic-read and retry.`,
          );
        }
        if (err instanceof NotFoundError) {
          return asError(
            `Unknown topic slug: "${slug}". It no longer exists (it may have been deleted).`,
          );
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'ws-topic-delete',
    {
      title: 'Topic: Delete',
      description:
        'Soft-delete a Topic by `slug` (it drops out of ws-topic-read). To undelete, call with ' +
        '`restore: true`. Unknown/already-deleted slug (or an already-live slug on restore) is ' +
        'rejected. Returns { ok, slug }.',
      inputSchema: {
        slug: z.string().describe('Slug of the topic to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted topic instead of deleting.'),
      },
    },
    async ({ slug, restore }) => {
      // For restore, the target row is soft-deleted, so it must be located with
      // includeDeleted; for a normal delete we want the live row only.
      const doc = store.getDocument({
        slug,
        kind: TOPIC_KIND,
        includeDeleted: restore === true,
      });
      if (!doc || doc.kind !== TOPIC_KIND) {
        return asError(
          restore === true
            ? `No soft-deleted topic with slug "${slug}" to restore.`
            : `Unknown topic slug: "${slug}". No live topic with that slug.`,
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
              ? `No soft-deleted topic with slug "${slug}" to restore.`
              : `Unknown or already-deleted topic slug: "${slug}".`,
          );
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'ws-topic-attach-workstream',
    {
      title: 'Topic: Attach Workstream',
      description:
        "Add a workstream slug to a Topic's `workstreams` membership (IDEMPOTENT — attaching an " +
        'already-attached workstream is a no-op success). Reads the topic, adds the slug, ' +
        're-validates, and CAS-writes. This is the atomic "attach topic to workstream" the panel ' +
        'needs. Returns the updated topic.',
      inputSchema: {
        slug: z.string().describe('Slug of the topic to attach the workstream to.'),
        workstream: z.string().describe('Workstream slug to add to the topic membership.'),
      },
    },
    async ({ slug, workstream }) => {
      const existing = store.getDocument({ slug, kind: TOPIC_KIND });
      if (!existing) {
        return asError(`Unknown topic slug: "${slug}". No live topic with that slug.`);
      }
      const current = stringArray(existing.spec?.workstreams);
      if (current.includes(workstream)) {
        // Already a member → idempotent no-op success (no CAS write).
        return asText(new Topic(existing));
      }
      return writeWorkstreamMembership(store, existing, slug, [...current, workstream]);
    },
  );

  server.registerTool(
    'ws-topic-detach-workstream',
    {
      title: 'Topic: Detach Workstream',
      description:
        "Remove a workstream slug from a Topic's `workstreams` membership (IDEMPOTENT — detaching " +
        'a workstream that is not a member is a no-op success). Reads the topic, removes the slug, ' +
        're-validates, and CAS-writes. Returns the updated topic.',
      inputSchema: {
        slug: z.string().describe('Slug of the topic to detach the workstream from.'),
        workstream: z.string().describe('Workstream slug to remove from the topic membership.'),
      },
    },
    async ({ slug, workstream }) => {
      const existing = store.getDocument({ slug, kind: TOPIC_KIND });
      if (!existing) {
        return asError(`Unknown topic slug: "${slug}". No live topic with that slug.`);
      }
      const current = stringArray(existing.spec?.workstreams);
      if (!current.includes(workstream)) {
        // Not a member → idempotent no-op success (no CAS write).
        return asText(new Topic(existing));
      }
      return writeWorkstreamMembership(
        store,
        existing,
        slug,
        current.filter((w) => w !== workstream),
      );
    },
  );
}

export default topic;
