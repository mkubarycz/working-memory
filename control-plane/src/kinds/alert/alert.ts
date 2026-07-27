/**
 * The `Alert` domain object — a PURE-DATA POCO reconstructed from an Alert
 * document envelope.
 *
 * This file is a ROOT of the alert folder's import graph: it imports NOTHING
 * from its siblings (only the store's `DocumentEnvelope` type), so `index.ts`
 * can depend on it without creating a cycle.
 *
 * `class Alert` carries every field as a public instance property assigned in
 * its constructor from a `DocumentEnvelope` — NO methods, NO getters — so
 * `JSON.stringify(new Alert(env))` is a stable projection of the document.
 *
 * The document↔domain mapping (mirrors migrations 016 + 017):
 *   - `id`                 ← `metadata.id`   (the control-plane uuid; the
 *                            extension's INTEGER PK is not carried over — Alerts
 *                            have NO slug, so `slug` is always null)
 *   - `title`              ← `spec.title` (absent → '')
 *   - `description`        ← `spec.description`
 *   - `recommended_action` ← `spec.recommended_action` (absent → '')
 *   - `status`             ← `spec.status` (alert | informational | closed)
 *   - `dedupe_key`         ← `spec.dedupe_key` (absent → null)
 *   - `created_by`         ← `spec.created_by` (absent → 'system')
 *   - `created_at`         ← `metadata.createdAt`
 *   - `updated_at`         ← `metadata.updatedAt`
 *   - `resourceVersion`    ← `metadata.resourceVersion` (carried so callers can update)
 */

import type { DocumentEnvelope } from '../../store.js';

/** The authored alert lifecycle status (a `spec` field), mirroring migration 016. */
export type AlertStatus = 'alert' | 'informational' | 'closed';

/**
 * The legacy alert shape, reconstructed from an Alert document. This is the
 * interface `class Alert` implements.
 */
export interface IAlert {
  id: string;
  slug: string | null;
  title: string;
  description: string;
  recommended_action: string;
  status: AlertStatus;
  dedupe_key: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

/** A pure-data projection of an Alert document envelope onto the legacy alert shape. */
export class Alert implements IAlert {
  id: string;
  slug: string | null;
  title: string;
  description: string;
  recommended_action: string;
  status: AlertStatus;
  dedupe_key: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;

  constructor(env: DocumentEnvelope) {
    const spec = env.spec ?? {};
    this.id = env.metadata.id;
    this.slug = env.metadata.slug;
    this.title = typeof spec.title === 'string' ? spec.title : '';
    this.description = typeof spec.description === 'string' ? spec.description : '';
    this.recommended_action =
      typeof spec.recommended_action === 'string' ? spec.recommended_action : '';
    this.status = (spec.status as AlertStatus | undefined) ?? 'alert';
    this.dedupe_key = typeof spec.dedupe_key === 'string' ? spec.dedupe_key : null;
    this.created_by = typeof spec.created_by === 'string' ? spec.created_by : 'system';
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}
