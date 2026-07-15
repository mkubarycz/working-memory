/**
 * Type shapes for the nanites feature (background-tasks engine, roadmap 12.2).
 * Kept under `src/nanites/` so the whole feature — like `src/alerts/` — lives
 * in one place and can be reasoned about (and toggled) independently of
 * `src/db.ts`.
 *
 * A *nanite* is a headless, one-shot, idempotent subagent defined entirely in
 * the DB: typed inputs, an allow-listed tool set, a model, instructions, and a
 * structured output. Its work product is surfaced through the alerts framework.
 */

export type NaniteRunStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface Nanite {
  id: number;
  slug: string;
  title: string;
  kind: string;
  trigger_phrase: string;
  instructions: string;
  /** null → the runner picks a sensible default model. */
  model: string | null;
  /** Parsed from the `tool_allowlist` JSON TEXT column. */
  tool_allowlist: string[];
  /** Raw JSON TEXT (or null). Kept as-is; the runner does not interpret it. */
  input_schema: string | null;
  output_schema: string | null;
  enabled: boolean;
  /** Human-written rubric the run's output is judged against. Required. */
  acceptance_criteria: string;
  /** Minimum judge confidence (0-100) for a run to count as succeeded. */
  acceptance_threshold: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
}

export interface NaniteRun {
  id: number;
  nanite_id: number;
  status: NaniteRunStatus;
  started_at: number | null;
  ended_at: number | null;
  /** Parsed from the `result` JSON TEXT column, or null. */
  result: unknown;
  error: string | null;
  created_at: number;
}

export interface CreateNaniteInput {
  slug: string;
  title?: string;
  kind?: string;
  trigger_phrase?: string;
  instructions: string;
  model?: string | null;
  tool_allowlist?: string[];
  input_schema?: string | null;
  output_schema?: string | null;
  enabled?: boolean;
  /** Required, non-empty rubric the run output is judged against. */
  acceptance_criteria: string;
  /** Minimum judge confidence (0-100) to pass. Defaults to 60. */
  acceptance_threshold?: number;
}

export interface ListNanitesInput {
  /** Include disabled nanites. Defaults to false (enabled-only). */
  include_disabled?: boolean;
  /** Include soft-deleted nanites. Defaults to false. */
  include_deleted?: boolean;
}

/**
 * Partial update of a nanite's config (mirrors `UpdateTopicInput`). Every
 * field is optional; only the ones provided are patched, and any change bumps
 * `updated_at`. `slug`, `created_at`, and the run audit trail are immutable.
 */
export interface UpdateNaniteInput {
  title?: string;
  kind?: string;
  trigger_phrase?: string;
  instructions?: string;
  model?: string | null;
  tool_allowlist?: string[];
  input_schema?: string | null;
  output_schema?: string | null;
  enabled?: boolean;
  /** New rubric. Must be non-empty when provided. */
  acceptance_criteria?: string;
  /** New minimum judge confidence (0-100). */
  acceptance_threshold?: number;
}

/**
 * Result of soft-deleting a nanite (mirrors `SoftDeleteTopicResult`). Nanites
 * have no cross-ref link tables, so a single affected-row count is enough.
 */
export interface SoftDeleteNaniteResult {
  nanites: number;
}

/** Result of restoring a soft-deleted nanite (mirrors `RestoreTopicResult`). */
export interface RestoreNaniteResult {
  nanites: number;
}
