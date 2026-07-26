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
import { Base, type KindModule } from './base.js';

const topicType: KindModule = {
  name: 'TopicType',
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
};

export default topicType;
