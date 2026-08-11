/**
 * The `Config` domain object (a "configmap") — a PURE-DATA POCO reconstructed
 * from a Config document envelope.
 *
 * A *Config* holds one or more **key-value pairs** (`data`) plus a human `name`
 * and an authored `status`, identified by a registry-key `slug` (e.g.
 * `banking-app-developer`). It is a first-class kind like TopicType: a nanite
 * references configmaps by slug/id in its `configs` array and, on run, their
 * merged `data` is injected into the nanite's dev container as environment
 * variables (so e.g. a `GH_TOKEN` key reaches the container).
 *
 * This file is a ROOT of the config folder's import graph: it imports NOTHING
 * from its siblings (only the store's `DocumentEnvelope` type), so `index.ts`
 * can depend on it without creating a cycle.
 *
 * The document↔domain mapping:
 *   - `id`       ← `metadata.id`   (the control-plane uuid)
 *   - `slug`     ← `metadata.slug` (the registry key, e.g. 'banking-app-developer')
 *   - `name`     ← `spec.name`     (human label; absent → '')
 *   - `data`     ← `spec.data`     (the key-value pairs; non-string values dropped)
 *   - `status`   ← `spec.status`   (authored lifecycle/free-form; absent → '')
 *   - `created_at`      ← `metadata.createdAt`
 *   - `updated_at`      ← `metadata.updatedAt`
 *   - `resourceVersion` ← `metadata.resourceVersion` (carried so callers can update)
 */

import type { DocumentEnvelope } from '../../store.js';

/** The Config kind name in the control-plane registry. */
export const CONFIG_KIND = 'Config';

/** The configmap shape, reconstructed from a Config document. */
export interface IConfig {
  id: string;
  slug: string | null;
  name: string;
  /** One or more key-value pairs. Values are always strings. */
  data: Record<string, string>;
  status: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

/** A pure-data projection of a Config document envelope onto the configmap shape. */
export class Config implements IConfig {
  id: string;
  slug: string | null;
  name: string;
  data: Record<string, string>;
  status: string;
  created_at: number;
  updated_at: number;
  resourceVersion: number;

  constructor(env: DocumentEnvelope) {
    const spec = env.spec ?? {};
    this.id = env.metadata.id;
    this.slug = env.metadata.slug;
    this.name = typeof spec.name === 'string' ? spec.name : '';
    this.data = readData(spec.data);
    this.status = typeof spec.status === 'string' ? spec.status : '';
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}

/**
 * Reconstruct the key-value map from a spec blob, keeping ONLY string values
 * (the kind schema enforces this on write; this guards a hand-edited document).
 * Returns an empty object on an absent/foreign shape.
 */
function readData(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      out[k] = v;
    }
  }
  return out;
}
