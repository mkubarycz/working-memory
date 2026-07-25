/**
 * The `Topic` kind — mirrors the extension's existing topics
 * (slug + title + body + open|closed + topic_type) as a control-plane document.
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
 */

import { z } from 'zod';
import { Base, type KindModule } from './base.js';

const topic: KindModule = {
  name: 'Topic',
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
      })
      .strict(),
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    fts: (r) => `${r.spec.title}\n${r.spec.body}`,
  },
};

export default topic;
