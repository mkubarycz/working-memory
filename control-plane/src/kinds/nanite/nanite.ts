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
export type NanitePhase = 'Pending' | 'Running' | 'Succeeded' | 'Failed';

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

/** Approximate token usage (loop + judge) recorded on a finished Nanite. */
export interface NaniteTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/** All valid phases, in lifecycle order. */
export const NANITE_PHASES: readonly NanitePhase[] = [
  'Pending',
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
  request: string;
  phase: NanitePhase;
  startedAt: number | null;
  endedAt: number | null;
  error: string;
  /** The full request text actually sent to the model (instructions + context). */
  prompt: string;
  /** The run's verbatim final text (empty until it finishes). */
  output: string;
  /** Allow-list entries that weren't available at run time. */
  missingTools: string[];
  /** The acceptance verdict (null until the run is judged). */
  acceptance: NaniteAcceptance | null;
  /** The run's tool-call trail, in execution order. */
  toolCalls: NaniteToolCallOutcome[];
  /** Approximate token usage (loop + judge), or null before the run finishes. */
  tokens: NaniteTokenUsage | null;
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
  request: string;
  phase: NanitePhase;
  startedAt: number | null;
  endedAt: number | null;
  error: string;
  prompt: string;
  output: string;
  missingTools: string[];
  acceptance: NaniteAcceptance | null;
  toolCalls: NaniteToolCallOutcome[];
  tokens: NaniteTokenUsage | null;
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
    this.request = typeof spec.request === 'string' ? spec.request : '';
    this.phase = (spec.phase as NanitePhase | undefined) ?? 'Pending';
    this.startedAt = typeof spec.startedAt === 'number' ? spec.startedAt : null;
    this.endedAt = typeof spec.endedAt === 'number' ? spec.endedAt : null;
    this.error = typeof spec.error === 'string' ? spec.error : '';
    this.prompt = typeof spec.prompt === 'string' ? spec.prompt : '';
    this.output = typeof spec.output === 'string' ? spec.output : '';
    this.missingTools = Array.isArray(spec.missingTools)
      ? spec.missingTools.filter((x): x is string => typeof x === 'string')
      : [];
    this.acceptance = readAcceptance(spec.acceptance);
    this.toolCalls = readToolCalls(spec.toolCalls);
    this.tokens = readTokens(spec.tokens);
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}

/** Reconstruct the acceptance verdict from a spec blob (null on absent/foreign). */
function readAcceptance(value: unknown): NaniteAcceptance | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as Record<string, unknown>;
  return {
    summary: typeof v.summary === 'string' ? v.summary : '',
    confidence: typeof v.confidence === 'number' ? v.confidence : 0,
    threshold: typeof v.threshold === 'number' ? v.threshold : 0,
    passed: v.passed === true,
  };
}

/** Reconstruct the tool-call trail from a spec blob (empty on absent/foreign). */
function readToolCalls(value: unknown): NaniteToolCallOutcome[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: NaniteToolCallOutcome[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && typeof (item as { name?: unknown }).name === 'string') {
      const v = item as Record<string, unknown>;
      out.push({
        name: v.name as string,
        ok: v.ok === true,
        ...(typeof v.error === 'string' ? { error: v.error } : {}),
      });
    }
  }
  return out;
}

/** Reconstruct approximate token usage from a spec blob (null on absent/foreign). */
function readTokens(value: unknown): NaniteTokenUsage | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const v = value as Record<string, unknown>;
  return {
    input_tokens: typeof v.input_tokens === 'number' ? v.input_tokens : 0,
    output_tokens: typeof v.output_tokens === 'number' ? v.output_tokens : 0,
    total_tokens: typeof v.total_tokens === 'number' ? v.total_tokens : 0,
  };
}
