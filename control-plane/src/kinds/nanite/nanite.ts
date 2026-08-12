/**
 * The `Nanite` domain object — a PURE-DATA POCO reconstructed from a Nanite
 * document envelope.
 *
 * A *Nanite* is ONE execution instance of a {@link NaniteTemplate} (the OLD
 * model called this a "Job"/"Run"; the NEW model calls the instance a
 * **Nanite** and the definition a **Nanite Template**). Every Nanite is created
 * against (a) an owning **workstream** and (b) an input **topic** — the topic IS
 * the input. Both are IMMUTABLE at creation: there is no update tool that edits
 * them; only `ws-nanite-run` mutates the lifecycle `phase` + timings.
 *
 * This file is a ROOT of the nanite folder's import graph: it imports NOTHING
 * from its siblings (only the store's `DocumentEnvelope` type).
 *
 * The document↔domain mapping:
 *   - `id`           ← `metadata.id`   (Nanites have NO slug — always null)
 *   - `templateId`   ← `spec.templateId` (owning template slug/id; absent → null)
 *   - `workstream`   ← `spec.workstream` (owning workstream slug; REQUIRED, immutable)
 *   - `inputTopic`   ← `spec.inputTopic` (input topic slug; REQUIRED, immutable)
 *   - `configs`      ← `spec.configs`    (configmap slugs/ids for env injection; immutable)
 *   - `request`      ← `spec.request`   (the free-text request/prompt)
 *   - `phase`        ← `spec.phase`     (Pending | Running | Succeeded | Failed)
 *   - `startedAt`    ← `spec.startedAt` (unix seconds when Run began; else null)
 *   - `endedAt`      ← `spec.endedAt`   (unix seconds when Run finished; else null)
 *   - `error`        ← `spec.error`     (failure message; else '')
 *   - `created_at`   ← `metadata.createdAt`
 *   - `updated_at`   ← `metadata.updatedAt`
 *   - `resourceVersion` ← `metadata.resourceVersion`
 */

import type { DocumentEnvelope } from '../../store.js';

/** The Nanite kind name in the control-plane registry. */
export const NANITE_KIND = 'Nanite';

/** The Nanite lifecycle phase (a `spec` field). */
export type NanitePhase = 'Pending' | 'Queued' | 'Running' | 'Succeeded' | 'Failed';

/** The acceptance-judge verdict persisted on a finished Nanite. */
export interface NaniteAcceptance {
  /** Plain-language rationale for the pass/fail judgement. */
  summary: string;
  /** Judge confidence (0-100). */
  confidence: number;
  /** Minimum confidence the run needed to pass. */
  threshold: number;
  passed: boolean;
}

/** One entry in a run's tool-call trail (name + ok + optional error). */
export interface NaniteToolCallOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

/** A body-free identity projection of one item from a WM read tool result. */
export interface NaniteReadDigestItem {
  id?: string;
  slug?: string;
  title?: string;
  name?: string;
  resourceVersion?: number;
}

/**
 * A compact, body-free digest of a Working-Memory READ tool result, captured at
 * record time so the friendly Execution rendering never depends on the
 * truncated `result` preview. `count` is the true total; `items` is capped and
 * carries only identity fields (no bodies).
 */
export interface NaniteReadResultDigest {
  count: number;
  items: NaniteReadDigestItem[];
}

/**
 * A body-free identity of the dev container a container-backed tool step ran
 * inside: the run's container `id` (the `wm-nanite` id-label value) plus, when
 * cheaply resolvable, the OrbStack `name` + `<name>.orb.local` `host`. Carries
 * NO secrets, so it is safe to persist and render.
 */
export interface NaniteContainerIdentity {
  id: string;
  name?: string;
  host?: string;
}

/**
 * One ordered step in a run's execution trace: the model's narration
 * (`kind: 'assistant'`) or a single tool call (`kind: 'tool'`), in execution
 * order. Richer than {@link NaniteToolCallOutcome} — it also carries between-tool
 * narration and truncated arg/result previews so the full workflow can be
 * rendered inline with the response.
 */
export interface NaniteRunStep {
  kind: 'assistant' | 'tool';
  /** Zero/one-based model-turn index this step occurred in (the run's round). */
  round?: number;
  text?: string;
  name?: string;
  ok?: boolean;
  input?: string;
  result?: string;
  error?: string;
  /**
   * Compact, body-free digest of a WM READ tool result (`kind: 'tool'`, success
   * only), captured from the FULL result before `result` was truncated.
   */
  resultDigest?: NaniteReadResultDigest;
  /**
   * The dev container this step ran inside — stamped ONLY on container-backed
   * tool steps (`run_command` / `expose_port`).
   */
  container?: NaniteContainerIdentity;
}

/** Approximate token usage (loop + judge) recorded on a finished Nanite. */
export interface NaniteTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** All valid phases, in lifecycle order. */
export const NANITE_PHASES: readonly NanitePhase[] = [
  'Pending',
  'Queued',
  'Running',
  'Succeeded',
  'Failed',
];

/** The Nanite shape, reconstructed from a Nanite document. */
export interface INanite {
  id: string;
  slug: string | null;
  templateId: string | null;
  workstream: string;
  inputTopic: string;
  /** Configmap slugs/ids injected into the run's dev container as env. */
  configs: string[];
  request: string;
  phase: NanitePhase;
  /** Unix seconds the nanite was enqueued for dispatch (null until Queued). */
  queuedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  error: string;
  /** Light pointer to the newest {@link NaniteJournal} for this nanite (null until first run). */
  latestJournalId: string | null;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

/** A pure-data projection of a Nanite document envelope. */
export class Nanite implements INanite {
  id: string;
  slug: string | null;
  templateId: string | null;
  workstream: string;
  inputTopic: string;
  configs: string[];
  request: string;
  phase: NanitePhase;
  queuedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  error: string;
  latestJournalId: string | null;
  created_at: number;
  updated_at: number;
  resourceVersion: number;

  constructor(env: DocumentEnvelope) {
    const spec = env.spec ?? {};
    this.id = env.metadata.id;
    this.slug = env.metadata.slug;
    this.templateId = typeof spec.templateId === 'string' ? spec.templateId : null;
    this.workstream = typeof spec.workstream === 'string' ? spec.workstream : '';
    this.inputTopic = typeof spec.inputTopic === 'string' ? spec.inputTopic : '';
    this.configs = Array.isArray(spec.configs)
      ? spec.configs.filter((x): x is string => typeof x === 'string')
      : [];
    this.request = typeof spec.request === 'string' ? spec.request : '';
    this.phase = (spec.phase as NanitePhase | undefined) ?? 'Pending';
    this.queuedAt = typeof spec.queuedAt === 'number' ? spec.queuedAt : null;
    this.startedAt = typeof spec.startedAt === 'number' ? spec.startedAt : null;
    this.endedAt = typeof spec.endedAt === 'number' ? spec.endedAt : null;
    this.error = typeof spec.error === 'string' ? spec.error : '';
    this.latestJournalId =
      typeof spec.latestJournalId === 'string' ? spec.latestJournalId : null;
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}
