/**
 * The `TopicType` domain object — a PURE-DATA POCO reconstructed from a
 * TopicType document envelope.
 *
 * This file is a ROOT of the topictype folder's import graph: it imports NOTHING
 * from its siblings (only the store's `DocumentEnvelope` type), so `index.ts`
 * can depend on it without creating a cycle.
 *
 * `class TopicType` carries every field as a public instance property assigned
 * in its constructor from a `DocumentEnvelope` — NO methods, NO getters — so
 * `JSON.stringify(new TopicType(env))` is a stable projection of the document.
 * Field declaration order AND constructor assignment order both match, so the
 * serialized key order is stable.
 *
 * The document↔domain mapping (mirrors migrations 008 + 013):
 *   - `id`            ← `metadata.id`   (the control-plane uuid)
 *   - `slug`          ← `metadata.slug` (the registry key, e.g. 'feature')
 *   - `label`         ← `spec.label`
 *   - `icon`          ← `spec.icon`
 *   - `description`   ← `spec.description`
 *   - `body_template` ← `spec.body_template` (absent → '')
 *   - `created_at`    ← `metadata.createdAt`
 *   - `updated_at`    ← `metadata.updatedAt`
 *   - `resourceVersion` ← `metadata.resourceVersion` (carried so callers can update)
 */

import type { DocumentEnvelope } from '../../store.js';

/**
 * The legacy topic-type shape, reconstructed from a TopicType document. This is
 * the interface `class TopicType` implements.
 */
export interface ITopicType {
  id: string;
  slug: string | null;
  label: string;
  icon: string;
  description: string;
  body_template: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

/**
 * A pure-data projection of a TopicType document envelope onto the legacy
 * topic-type shape.
 */
export class TopicType implements ITopicType {
  id: string;
  slug: string | null;
  label: string;
  icon: string;
  description: string;
  body_template: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;

  constructor(env: DocumentEnvelope) {
    const spec = env.spec ?? {};
    this.id = env.metadata.id;
    this.slug = env.metadata.slug;
    this.label = typeof spec.label === 'string' ? spec.label : '';
    this.icon = typeof spec.icon === 'string' ? spec.icon : '';
    this.description = typeof spec.description === 'string' ? spec.description : '';
    this.body_template = typeof spec.body_template === 'string' ? spec.body_template : '';
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}
