/**
 * The `Alert` kind — mirrors the extension's `alerts` table
 * (schema/016_alerts.sql + schema/017_alert_title.sql) as a control-plane
 * document. Alerts are structured "needs attention" items raised by agents or
 * background tasks.
 *
 * Column → field placement (migrations 016 + 017):
 *   - `id`                 → `metadata.id`  (INTEGER PK AUTOINCREMENT — NOT a
 *                             string key, so there is NO `metadata.slug`
 *                             mapping; the control-plane assigns its own uuid
 *                             `metadata.id`). The nearest human string key is
 *                             `dedupe_key`, kept in spec below.
 *   - `created_at`         → `metadata.createdAt`
 *   - `updated_at`         → `metadata` timestamp
 *   - `title`              → spec (authored, NOT NULL DEFAULT '' — friendly
 *                             short title, migration 017)
 *   - `description`        → spec (authored, NOT NULL — the alert body/message)
 *   - `recommended_action` → spec (authored, NOT NULL DEFAULT '')
 *   - `status`             → spec (authored lifecycle enum, NOT NULL DEFAULT
 *                             'alert', CHECK IN ('alert','informational',
 *                             'closed') — mirrors migration 016. Same pattern as
 *                             Topic/Workstream: an AUTHORED status field, NOT the
 *                             controller-owned envelope status. NOTE: there is no
 *                             controller path yet; if a controller later owns the
 *                             lifecycle, this may move to envelope status.)
 *   - `dedupe_key`         → spec (authored, nullable — the recurrence key)
 *   - `created_by`         → spec (authored, NOT NULL DEFAULT 'system' — who
 *                             raised it)
 *
 * No envelope `status` schema → inherits Base's empty `{}` status. The authored
 * `spec.status` above is distinct from the envelope status (which stays Base's
 * empty object), same disambiguation as Topic/Workstream.
 *
 * Drop-in discovered by `loader.ts`; no registration list to edit.
 */

import { z } from 'zod';
import { Base, type KindModule } from './base.js';

const alert: KindModule = {
  name: 'Alert',
  descriptor: {
    extends: Base,
    spec: z
      .object({
        // `title` — NOT NULL DEFAULT '' (migration 017).
        title: z.string().default(''),
        // `description` — NOT NULL (migration 016); the alert body/message.
        description: z.string().min(1),
        // `recommended_action` — NOT NULL DEFAULT '' (migration 016).
        recommended_action: z.string().default(''),
        // AUTHORED lifecycle — a SPEC field, NOT the controller-owned envelope
        // status (which Alert inherits empty from Base). Enum + default mirror
        // migration 016's CHECK constraint and DEFAULT exactly.
        status: z.enum(['alert', 'informational', 'closed']).default('alert'),
        // `dedupe_key` — nullable in migration 016; optional here.
        dedupe_key: z.string().optional(),
        // `created_by` — NOT NULL DEFAULT 'system' (migration 016).
        created_by: z.string().default('system'),
      })
      .strict(),
    // No envelope `status` schema → inherit Base (lifecycle-only, empty {}).
    fts: (r) => `${r.spec.title}\n${r.spec.description}`,
  },
};

export default alert;
