/**
 * The `NaniteTemplate` domain object — a PURE-DATA POCO reconstructed from a
 * NaniteTemplate document envelope.
 *
 * A *Nanite Template* is the reusable DEFINITION of a headless subagent: its
 * trigger phrase, instructions, execution settings, allow-listed tools, typed
 * input/output schemas, and acceptance rubric. One template is instantiated
 * many times as a {@link Nanite} (one execution instance). This mirrors the old
 * pre-control-plane `nanites` table (schema/018_nanites.sql +
 * schema/019_nanite_acceptance.sql) — the OLD model called this a "Nanite"; the
 * new model renames the definition to **Nanite Template**.
 *
 * This file is a ROOT of the naniteTemplate folder's import graph: it imports
 * NOTHING from its siblings (only the store's `DocumentEnvelope` type), so
 * `index.ts` can depend on it without creating a cycle.
 *
 * The document↔domain mapping (mirrors migrations 018 + 019):
 *   - `id`                   ← `metadata.id`
 *   - `slug`                 ← `metadata.slug`
 *   - `title`                ← `spec.title`
 *   - `triggerPhrase`        ← `spec.triggerPhrase`  (018 `trigger_phrase`)
 *   - `instructions`         ← `spec.instructions`
 *   - `executionSettings`    ← `spec.executionSettings` (model + tuning; 018 `model`)
 *   - `toolAllowlist`        ← `spec.toolAllowlist`   (018 `tool_allowlist`)
 *   - `inputSchema`          ← `spec.inputSchema`
 *   - `outputSchema`         ← `spec.outputSchema`
 *   - `acceptanceCriteria`   ← `spec.acceptanceCriteria` (019)
 *   - `acceptanceThreshold`  ← `spec.acceptanceThreshold` (019)
 *   - `enabled`              ← `spec.enabled`
 *   - `created_at`           ← `metadata.createdAt`
 *   - `updated_at`           ← `metadata.updatedAt`
 *   - `resourceVersion`      ← `metadata.resourceVersion` (carried so callers can update)
 */

import type { DocumentEnvelope } from '../../store.js';

/** The NaniteTemplate kind name in the control-plane registry. */
export const NANITE_TEMPLATE_KIND = 'NaniteTemplate';

/** Read a `string[]` spec field defensively (absent / foreign shape → `[]`). */
export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Read an object spec field defensively (absent / foreign shape → `{}`). */
export function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The Nanite Template shape, reconstructed from a NaniteTemplate document. This
 * is the interface `class NaniteTemplate` implements.
 */
export interface INaniteTemplate {
  id: string;
  slug: string | null;
  title: string;
  triggerPhrase: string;
  instructions: string;
  executionSettings: Record<string, unknown>;
  toolAllowlist: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  acceptanceCriteria: string;
  acceptanceThreshold: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

/** A pure-data projection of a NaniteTemplate document envelope. */
export class NaniteTemplate implements INaniteTemplate {
  id: string;
  slug: string | null;
  title: string;
  triggerPhrase: string;
  instructions: string;
  executionSettings: Record<string, unknown>;
  toolAllowlist: string[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  acceptanceCriteria: string;
  acceptanceThreshold: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  resourceVersion: number;

  constructor(env: DocumentEnvelope) {
    const spec = env.spec ?? {};
    this.id = env.metadata.id;
    this.slug = env.metadata.slug;
    this.title = typeof spec.title === 'string' ? spec.title : '';
    this.triggerPhrase = typeof spec.triggerPhrase === 'string' ? spec.triggerPhrase : '';
    this.instructions = typeof spec.instructions === 'string' ? spec.instructions : '';
    this.executionSettings = plainObject(spec.executionSettings);
    this.toolAllowlist = stringArray(spec.toolAllowlist);
    this.inputSchema = plainObject(spec.inputSchema);
    this.outputSchema = plainObject(spec.outputSchema);
    this.acceptanceCriteria =
      typeof spec.acceptanceCriteria === 'string' ? spec.acceptanceCriteria : '';
    this.acceptanceThreshold =
      typeof spec.acceptanceThreshold === 'number' ? spec.acceptanceThreshold : 60;
    this.enabled = spec.enabled !== false;
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}
