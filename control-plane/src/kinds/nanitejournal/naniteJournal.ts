/**
 * The `NaniteJournal` domain object — a PURE-DATA POCO reconstructed from a
 * NaniteJournal document envelope.
 *
 * A *NaniteJournal* is ONE immutable record of a single {@link Nanite} run. It
 * exists so a run NEVER mutates the nanite spec (which is desired-state): every
 * run appends a NEW journal document referencing its owning `naniteId` +
 * `workstream` + `inputTopic`. The nanite keeps only a light `latestJournalId`
 * pointer to the newest record.
 *
 * The spec is organized into FOUR sections:
 *   - `status`    — phase/outcome + timing (queuedAt, startedAt, endedAt).
 *   - `prompt`    — all run input (the full request/instructions+context sent
 *                   to the model).
 *   - `execution` — the turn trace (`steps`) + any error encountered.
 *   - `results`   — summary of what was done, the acceptance verdict, and
 *                   execution stats (tokens, missingTools).
 *
 * This file is a ROOT of the nanitejournal folder's import graph: it imports
 * NOTHING from its siblings (only the store's `DocumentEnvelope` type and the
 * shared run-shape types from the Nanite kind, which is itself a leaf).
 */

import type { DocumentEnvelope } from '../../store.js';
import type {
  NaniteAcceptance,
  NaniteContainerIdentity,
  NanitePhase,
  NaniteReadDigestItem,
  NaniteReadResultDigest,
  NaniteRunStep,
  NaniteTokenUsage,
} from '../nanite/nanite.js';

/** The NaniteJournal kind name in the control-plane registry. */
export const NANITE_JOURNAL_KIND = 'NaniteJournal';

/** A run's terminal outcome (null until it finishes). */
export type NaniteRunOutcome = 'succeeded' | 'failed' | null;

/** Section 1 — the run's lifecycle phase/outcome + timing. */
export interface NaniteJournalStatus {
  phase: NanitePhase;
  outcome: NaniteRunOutcome;
  /** Unix seconds the run was enqueued (queue info). */
  queuedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

/** Section 2 — all run input handed to the model. */
export interface NaniteJournalPrompt {
  /** The full request text sent to the model (instructions + context). */
  request: string;
}

/** Section 3 — the turn trace + any error encountered. */
export interface NaniteJournalExecution {
  /** The run's ordered execution trace (narration + tool calls). */
  steps: NaniteRunStep[];
  /** The failure message, if the run errored (empty otherwise). */
  error: string;
}

/** Section 4 — the outcome summary, acceptance verdict, and execution stats. */
export interface NaniteJournalResults {
  /** Plain-language summary of what the run did (the run's final output). */
  summary: string;
  /** The acceptance-judge verdict (null when the run was never judged). */
  acceptance: NaniteAcceptance | null;
  /** Approximate token usage (loop + judge), or null. */
  tokens: NaniteTokenUsage | null;
  /** Allow-list entries that weren't available at run time. */
  missingTools: string[];
}

/** The NaniteJournal shape, reconstructed from a NaniteJournal document. */
export interface INaniteJournal {
  id: string;
  slug: string | null;
  /** The owning nanite's document id (REQUIRED). */
  naniteId: string;
  /** The owning workstream slug (scope). */
  workstream: string;
  /** The input topic slug (scope; empty for a workstream-wide run). */
  inputTopic: string;
  status: NaniteJournalStatus;
  prompt: NaniteJournalPrompt;
  execution: NaniteJournalExecution;
  results: NaniteJournalResults;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

/** A pure-data projection of a NaniteJournal document envelope. */
export class NaniteJournal implements INaniteJournal {
  id: string;
  slug: string | null;
  naniteId: string;
  workstream: string;
  inputTopic: string;
  status: NaniteJournalStatus;
  prompt: NaniteJournalPrompt;
  execution: NaniteJournalExecution;
  results: NaniteJournalResults;
  created_at: number;
  updated_at: number;
  resourceVersion: number;

  constructor(env: DocumentEnvelope) {
    const spec = env.spec ?? {};
    this.id = env.metadata.id;
    this.slug = env.metadata.slug;
    this.naniteId = typeof spec.naniteId === 'string' ? spec.naniteId : '';
    this.workstream = typeof spec.workstream === 'string' ? spec.workstream : '';
    this.inputTopic = typeof spec.inputTopic === 'string' ? spec.inputTopic : '';
    this.status = readStatus(spec.status);
    this.prompt = readPrompt(spec.prompt);
    this.execution = readExecution(spec.execution);
    this.results = readResults(spec.results);
    this.created_at = env.metadata.createdAt;
    this.updated_at = env.metadata.updatedAt;
    this.resourceVersion = env.metadata.resourceVersion;
  }
}

/** Reconstruct the status section from a spec blob (defaults on absent/foreign). */
function readStatus(value: unknown): NaniteJournalStatus {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const phase = v.phase;
  const outcome = v.outcome;
  return {
    phase:
      phase === 'Pending' ||
      phase === 'Queued' ||
      phase === 'Running' ||
      phase === 'Succeeded' ||
      phase === 'Failed'
        ? phase
        : 'Pending',
    outcome: outcome === 'succeeded' || outcome === 'failed' ? outcome : null,
    queuedAt: typeof v.queuedAt === 'number' ? v.queuedAt : null,
    startedAt: typeof v.startedAt === 'number' ? v.startedAt : null,
    endedAt: typeof v.endedAt === 'number' ? v.endedAt : null,
  };
}

/** Reconstruct the prompt section from a spec blob (empty on absent/foreign). */
function readPrompt(value: unknown): NaniteJournalPrompt {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return { request: typeof v.request === 'string' ? v.request : '' };
}

/** Reconstruct the execution section from a spec blob (empty on absent/foreign). */
function readExecution(value: unknown): NaniteJournalExecution {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    steps: readSteps(v.steps),
    error: typeof v.error === 'string' ? v.error : '',
  };
}

/** Reconstruct the results section from a spec blob (defaults on absent/foreign). */
function readResults(value: unknown): NaniteJournalResults {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    summary: typeof v.summary === 'string' ? v.summary : '',
    acceptance: readAcceptance(v.acceptance),
    tokens: readTokens(v.tokens),
    missingTools: Array.isArray(v.missingTools)
      ? v.missingTools.filter((x): x is string => typeof x === 'string')
      : [],
  };
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

/** Reconstruct the ordered execution trace from a spec blob (empty on absent/foreign). */
function readSteps(value: unknown): NaniteRunStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: NaniteRunStep[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const v = item as Record<string, unknown>;
    const kind = v.kind === 'assistant' || v.kind === 'tool' ? v.kind : null;
    if (!kind) {
      continue;
    }
    const step: NaniteRunStep = { kind };
    if (typeof v.round === 'number') {
      step.round = v.round;
    }
    if (typeof v.text === 'string') {
      step.text = v.text;
    }
    if (typeof v.name === 'string') {
      step.name = v.name;
    }
    if (typeof v.ok === 'boolean') {
      step.ok = v.ok;
    }
    if (typeof v.input === 'string') {
      step.input = v.input;
    }
    if (typeof v.result === 'string') {
      step.result = v.result;
    }
    if (typeof v.error === 'string') {
      step.error = v.error;
    }
    const digest = readResultDigest(v.resultDigest);
    if (digest) {
      step.resultDigest = digest;
    }
    const container = readContainerIdentity(v.container);
    if (container) {
      step.container = container;
    }
    out.push(step);
  }
  return out;
}

/** Reconstruct a step's container identity (undefined on absent/foreign shape). */
function readContainerIdentity(value: unknown): NaniteContainerIdentity | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || v.id === '') {
    return undefined;
  }
  const identity: NaniteContainerIdentity = { id: v.id };
  if (typeof v.name === 'string') {
    identity.name = v.name;
  }
  if (typeof v.host === 'string') {
    identity.host = v.host;
  }
  return identity;
}

/** Reconstruct a step's body-free read digest (undefined on absent/foreign shape). */
function readResultDigest(value: unknown): NaniteReadResultDigest | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  if (typeof v.count !== 'number') {
    return undefined;
  }
  const items: NaniteReadDigestItem[] = [];
  if (Array.isArray(v.items)) {
    for (const raw of v.items) {
      if (!raw || typeof raw !== 'object') {
        continue;
      }
      const r = raw as Record<string, unknown>;
      const item: NaniteReadDigestItem = {};
      if (typeof r.id === 'string') {
        item.id = r.id;
      }
      if (typeof r.slug === 'string') {
        item.slug = r.slug;
      }
      if (typeof r.title === 'string') {
        item.title = r.title;
      }
      if (typeof r.name === 'string') {
        item.name = r.name;
      }
      if (typeof r.resourceVersion === 'number') {
        item.resourceVersion = r.resourceVersion;
      }
      items.push(item);
    }
  }
  return { count: v.count, items };
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
