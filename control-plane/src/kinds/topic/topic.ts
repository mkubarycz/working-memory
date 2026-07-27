/**
 * The `Topic` domain object — a PURE-DATA POCO reconstructed from a Topic
 * document envelope.
 *
 * This file is a ROOT of the topic folder's import graph: it imports NOTHING
 * from its siblings (only the store's `DocumentEnvelope` type), so `index.ts`
 * can depend on it without creating a cycle.
 *
 * `class Topic` carries every field as a public instance property assigned in
 * its constructor from a `DocumentEnvelope` — NO methods, NO getters — so
 * `JSON.stringify(new Topic(env))` is a stable projection of the document,
 * byte-for-byte what the former `mapTopic` function returned. Field declaration
 * order AND constructor assignment order both match, so the serialized key
 * order is stable.
 *
 * The document↔domain mapping (mirrors the legacy topics row):
 *   - `id`            ← `metadata.id`
 *   - `slug`          ← `metadata.slug`
 *   - `title`         ← `spec.title`
 *   - `body`          ← `spec.body`
 *   - `status`        ← `spec.status`      (open | closed)
 *   - `topicType`     ← `spec.topicType`
 *   - `parents`       ← `spec.parents`     (parent topic slugs)
 *   - `workstreams`   ← `spec.workstreams` (member workstream slugs)
 *   - `focusedWorkstreams` ← `spec.focusedWorkstreams` (subset of `workstreams` this topic is focused/pinned in)
 *   - `created_at`    ← `metadata.createdAt`
 *   - `updated_at`    ← `metadata.updatedAt`
 *   - `resourceVersion` ← `metadata.resourceVersion` (carried so callers can update)
 */

import type { DocumentEnvelope } from '../../store.js';

/** The Topic kind name in the control-plane registry. */
export const TOPIC_KIND = 'Topic';

/** The authored open/closed status (a `spec` field), mirroring the Topic enum. */
export type TopicSpecStatus = 'open' | 'closed';

/** Read a `string[]` spec field defensively (absent / foreign shape → `[]`). */
export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * The legacy topic shape, reconstructed from a Topic document. This is the
 * interface `class Topic` implements.
 */
export interface ITopic {
  id: string;
  slug: string | null;
  title: string;
  body: string;
  status: TopicSpecStatus;
  topicType: string;
  parents: string[];
  workstreams: string[];
  /** Subset of `workstreams` this topic is focused/pinned in (per-workstream focus). */
  focusedWorkstreams: string[];
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

/**
 * A pure-data projection of a Topic document envelope onto the legacy topic
 * shape.
 */
export class Topic implements ITopic {
  id: string;
  slug: string | null;
  title: string;
  body: string;
  status: TopicSpecStatus;
  topicType: string;
  parents: string[];
  workstreams: string[];
  focusedWorkstreams: string[];
  created_at: number;
  updated_at: number;
  resourceVersion: number;

  constructor(env: DocumentEnvelope) {
    const spec = env.spec ?? {};
    this.id = env.metadata.id;
    this.slug = env.metadata.slug;
    this.title = typeof spec.title === 'string' ? spec.title : '';
    this.body = typeof spec.body === 'string' ? spec.body : '';
    this.status = (spec.status as TopicSpecStatus | undefined) ?? 'open';
    this.topicType = typeof spec.topicType === 'string' ? spec.topicType : 'topic';
    this.parents = stringArray(spec.parents);
    this.workstreams = stringArray(spec.workstreams);
    this.focusedWorkstreams = stringArray(spec.focusedWorkstreams);
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}
