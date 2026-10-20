/**
 * Pure snapshot planning/merge helpers for the external Thrive adapter.
 * Membership and server time must come from the authenticated, fixed host
 * operation, never from container-supplied IDs. This module performs no I/O.
 */
export const THRIVE_SNAPSHOT_LIMIT = 2_000;
export const THRIVE_OVERLAP_MS = 120_000;

export type ThriveClassification = 'OPEN' | 'CLOSED' | 'UNCLASSIFIED';

export interface ThriveRecord {
  id: number;
  revision: number;
  type: string;
  state: string;
  title: string;
}

export interface ThriveStateMetadata {
  type: string;
  state: string;
  category: string;
}

export interface ThriveSnapshot {
  checkpoint: string;
  records: Array<ThriveRecord & { classification: ThriveClassification }>;
  dataComplete: true;
  classificationComplete: boolean;
  counts: { tracked: number; knownOpen: number; knownClosed: number; unclassified: number };
}

export interface ThriveReadPlan {
  mode: 'full' | 'incremental';
  asOf: string;
  previousCheckpoint: string | null;
  changedSince: string | null;
  membershipIds: number[];
  removedIds: number[];
  historicalGets: Array<{ id: number; asOf: string }>;
}

function timestamp(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) {
    throw new Error('Expected a canonical UTC server timestamp.');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error('Invalid server timestamp.');
  }
  return time;
}

function ids(values: readonly number[]): number[] {
  if (!Array.isArray(values) || values.length > THRIVE_SNAPSHOT_LIMIT
      || values.some((id) => !Number.isSafeInteger(id) || id <= 0)
      || new Set(values).size !== values.length) {
    throw new Error('IDs must be unique positive integers within the snapshot budget.');
  }
  return [...values].sort((a, b) => a - b);
}

export function planThriveSnapshot(input: {
  mode: 'full' | 'incremental';
  asOf: string;
  previousCheckpoint?: string;
  /** Complete host-verified membership at asOf, including unchanged records. */
  membershipIds: readonly number[];
  changedIds: readonly number[];
  cachedIds: readonly number[];
}): ThriveReadPlan {
  if (input.mode !== 'full' && input.mode !== 'incremental') throw new Error('Invalid sync mode.');
  const asOf = timestamp(input.asOf);
  const previous = input.previousCheckpoint === undefined ? null : timestamp(input.previousCheckpoint);
  if (previous !== null && previous >= asOf) throw new Error('Snapshot must advance the checkpoint.');
  if (input.mode === 'incremental' && previous === null) throw new Error('Incremental sync needs a checkpoint.');
  const membership = ids(input.membershipIds);
  const changed = new Set(ids(input.changedIds));
  const cached = new Set(ids(input.cachedIds));
  const members = new Set(membership);
  return {
    mode: input.mode,
    asOf: input.asOf,
    previousCheckpoint: input.previousCheckpoint ?? null,
    changedSince: input.mode === 'incremental'
      ? new Date(Math.max(0, previous! - THRIVE_OVERLAP_MS)).toISOString() : null,
    membershipIds: membership,
    removedIds: [...cached].filter((id) => !members.has(id)).sort((a, b) => a - b),
    historicalGets: membership
      .filter((id) => input.mode === 'full' || changed.has(id) || !cached.has(id))
      .map((id) => ({ id, asOf: input.asOf })),
  };
}

function normalized(record: ThriveRecord): ThriveRecord {
  if (!record || !Number.isSafeInteger(record.id) || record.id <= 0
      || !Number.isSafeInteger(record.revision) || record.revision <= 0
      || typeof record.type !== 'string' || !record.type || record.type.length > 128
      || typeof record.state !== 'string' || !record.state || record.state.length > 128
      || typeof record.title !== 'string' || record.title.length > 512) {
    throw new Error('Invalid normalized work item.');
  }
  // Deliberately project only the data contract, not arbitrary upstream fields.
  return { id: record.id, revision: record.revision, type: record.type, state: record.state, title: record.title };
}

export function classifyThriveState(category: string | undefined): ThriveClassification {
  switch (category) {
    case 'Proposed':
    case 'InProgress':
    case 'Resolved':
      return 'OPEN';
    case 'Completed':
    case 'Removed':
      return 'CLOSED';
    default:
      return 'UNCLASSIFIED';
  }
}

/**
 * Call only after the broker manifest, ownership and attempt binding checks.
 * Returns a new candidate snapshot; the adapter must atomically CAS it into
 * Redis with the checkpoint. An error never mutates the previous snapshot.
 */
export function mergeThriveSnapshot(input: {
  plan: ThriveReadPlan;
  previous: ThriveSnapshot | null;
  details: Array<{ asOf: string; record: ThriveRecord }>;
  stateMetadata: ThriveStateMetadata[];
  membershipComplete: boolean;
  detailsComplete: boolean;
}): ThriveSnapshot {
  const { plan, previous } = input;
  timestamp(plan.asOf);
  if (!input.membershipComplete || !input.detailsComplete) throw new Error('Incomplete snapshot.');
  if ((previous?.checkpoint ?? null) !== plan.previousCheckpoint) throw new Error('Stale snapshot base.');
  if (previous && timestamp(previous.checkpoint) >= timestamp(plan.asOf)) throw new Error('Stale snapshot.');
  const membership = ids(plan.membershipIds);
  const needed = new Set(ids(plan.historicalGets.map((get) => {
    if (get.asOf !== plan.asOf) throw new Error('Historical read timestamp mismatch.');
    return get.id;
  })));
  if ([...needed].some((id) => !membership.includes(id))) throw new Error('Out-of-scope detail request.');
  if (plan.mode === 'full' && needed.size !== membership.length) throw new Error('Incomplete full plan.');
  if (input.details.length !== needed.size) throw new Error('Incomplete or duplicate historical details.');
  const records = new Map<number, ThriveRecord>();
  for (const record of previous?.records ?? []) {
    if (records.has(record.id)) throw new Error('Duplicate cached record.');
    records.set(record.id, normalized(record));
  }
  const seen = new Set<number>();
  for (const detail of input.details) {
    const record = normalized(detail.record);
    if (detail.asOf !== plan.asOf || !needed.has(record.id) || seen.has(record.id)) {
      throw new Error('Unexpected, duplicate, or nonhistorical detail.');
    }
    if (record.revision < (records.get(record.id)?.revision ?? 0)) throw new Error('Revision regression.');
    seen.add(record.id);
    records.set(record.id, record);
  }
  if (input.stateMetadata.length > 10_000) throw new Error('State metadata budget exceeded.');
  const metadata = new Map<string, string>();
  for (const entry of input.stateMetadata) {
    if (typeof entry.type !== 'string' || !entry.type || entry.type.length > 128
        || typeof entry.state !== 'string' || !entry.state || entry.state.length > 128
        || typeof entry.category !== 'string' || entry.category.length > 128) {
      throw new Error('Invalid state metadata.');
    }
    const key = JSON.stringify([entry.type, entry.state]);
    if (metadata.has(key)) throw new Error('Duplicate state metadata.');
    metadata.set(key, entry.category);
  }
  const counts = { tracked: membership.length, knownOpen: 0, knownClosed: 0, unclassified: 0 };
  const result = membership.map((id) => {
    const record = records.get(id);
    if (!record) throw new Error('Missing member detail.');
    const classification = classifyThriveState(metadata.get(JSON.stringify([record.type, record.state])));
    if (classification === 'OPEN') counts.knownOpen++;
    else if (classification === 'CLOSED') counts.knownClosed++;
    else counts.unclassified++;
    return { ...record, classification };
  });
  return {
    checkpoint: plan.asOf,
    records: result,
    dataComplete: true,
    classificationComplete: counts.unclassified === 0,
    counts,
  };
}
