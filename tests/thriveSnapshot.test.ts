import { describe, expect, it } from 'vitest';
import {
  classifyThriveState, mergeThriveSnapshot, planThriveSnapshot,
  THRIVE_SNAPSHOT_LIMIT, type ThriveRecord, type ThriveSnapshot,
} from '../shared/thriveSnapshot';

const BEFORE = '2026-10-20T12:00:00.000Z';
const NOW = '2026-10-20T12:05:00.000Z';
const item = (id: number, state = 'Active'): ThriveRecord => ({
  id, revision: 1, type: 'Fixture Task', state, title: `Synthetic item ${id}`,
});
const metadata = [{ type: 'Fixture Task', state: 'Active', category: 'InProgress' }];
function full(records = [item(1)]) {
  return mergeThriveSnapshot({
    plan: planThriveSnapshot({
      mode: 'full', asOf: BEFORE, membershipIds: records.map((record) => record.id), changedIds: [], cachedIds: [],
    }),
    previous: null, details: records.map((record) => ({ asOf: BEFORE, record })),
    stateMetadata: metadata, membershipComplete: true, detailsComplete: true,
  });
}
function incremental(previous: ThriveSnapshot, membershipIds = [1], changedIds: number[] = []) {
  return planThriveSnapshot({
    mode: 'incremental', asOf: NOW, previousCheckpoint: previous.checkpoint,
    membershipIds, changedIds, cachedIds: previous.records.map((record) => record.id),
  });
}

describe('Thrive snapshot planning', () => {
  it('uses one historical snapshot, two-minute overlap and complete membership for incremental reads', () => {
    const plan = incremental(full([item(1), item(2)]), [1, 3], [2, 99]);
    expect(plan.changedSince).toBe('2026-10-20T11:58:00.000Z');
    expect(plan.removedIds).toEqual([2]);
    expect(plan.historicalGets).toEqual([{ id: 3, asOf: NOW }]);
  });

  it('fetches changed members but never authorizes out-of-scope submitted IDs', () => {
    expect(incremental(full(), [1], [1, 999]).historicalGets).toEqual([{ id: 1, asOf: NOW }]);
  });

  it('full reconciliation reads every current member', () => {
    expect(planThriveSnapshot({
      mode: 'full', asOf: NOW, membershipIds: [2, 1], changedIds: [], cachedIds: [1, 2],
    }).historicalGets).toEqual([{ id: 1, asOf: NOW }, { id: 2, asOf: NOW }]);
  });

  it.each(['2026-10-20', '2026-02-30T12:05:00.000Z', 'bad'])('rejects invalid server time %s', (asOf) => {
    expect(() => planThriveSnapshot({
      mode: 'full', asOf, membershipIds: [], changedIds: [], cachedIds: [],
    })).toThrow();
  });

  it('requires an earlier checkpoint for incremental reads', () => {
    for (const previousCheckpoint of [undefined, NOW, '2026-10-20T12:06:00.000Z']) {
      expect(() => planThriveSnapshot({
        mode: 'incremental', asOf: NOW, previousCheckpoint, membershipIds: [], changedIds: [], cachedIds: [],
      })).toThrow();
    }
  });

  it.each([
    { membershipIds: [1, 1] }, { membershipIds: [0] }, { membershipIds: [-1] }, { membershipIds: [1.5] },
    { membershipIds: Array.from({ length: THRIVE_SNAPSHOT_LIMIT + 1 }, (_, i) => i + 1) },
  ])(
    'rejects duplicate, invalid or unbounded IDs %#', ({ membershipIds }) => {
      expect(() => planThriveSnapshot({
        mode: 'full', asOf: NOW, membershipIds, changedIds: [], cachedIds: [],
      })).toThrow();
    },
  );
});

describe('lossless classification and complete merge', () => {
  it('preserves legacy states explicitly, separate from data completeness', () => {
    const snapshot = full([item(1), item(2, 'Legacy Completed')]);
    expect(snapshot.records[1].state).toBe('Legacy Completed');
    expect(snapshot.records[1].classification).toBe('UNCLASSIFIED');
    expect(snapshot.dataComplete).toBe(true);
    expect(snapshot.classificationComplete).toBe(false);
    expect(snapshot.counts).toEqual({ tracked: 2, knownOpen: 1, knownClosed: 0, unclassified: 1 });
  });

  it('does not infer a category from a state name or unknown metadata category', () => {
    expect(classifyThriveState(undefined)).toBe('UNCLASSIFIED');
    expect(classifyThriveState('SomeFutureCategory')).toBe('UNCLASSIFIED');
    expect(full([item(1, 'Completed')]).counts.knownClosed).toBe(0);
  });

  it('reevaluates every cached record when metadata changes, even without changed details', () => {
    const previous = full();
    const snapshot = mergeThriveSnapshot({
      plan: incremental(previous), previous, details: [],
      stateMetadata: [{ type: 'Fixture Task', state: 'Active', category: 'Completed' }],
      membershipComplete: true, detailsComplete: true,
    });
    expect(snapshot.counts).toEqual({ tracked: 1, knownOpen: 0, knownClosed: 1, unclassified: 0 });
    expect(previous.records[0].classification).toBe('OPEN');
  });

  it('removes departed/deleted members and accepts an empty authoritative snapshot', () => {
    const previous = full();
    const snapshot = mergeThriveSnapshot({
      plan: incremental(previous, []), previous, details: [], stateMetadata: [],
      membershipComplete: true, detailsComplete: true,
    });
    expect(snapshot.records).toEqual([]);
    expect(snapshot.checkpoint).toBe(NOW);
    expect(snapshot.classificationComplete).toBe(true);
  });

  it('merges newly matching records even when the changed query did not return them', () => {
    const previous = full();
    const plan = incremental(previous, [1, 2]);
    const snapshot = mergeThriveSnapshot({
      plan, previous, details: [{ asOf: NOW, record: item(2) }], stateMetadata: metadata,
      membershipComplete: true, detailsComplete: true,
    });
    expect(snapshot.records.map((record) => record.id)).toEqual([1, 2]);
    expect(snapshot.counts.knownOpen).toBe(2);
  });

  it('full reconciliation replaces details and removes departed members from an existing cache', () => {
    const previous = full([item(1), item(2)]);
    const plan = planThriveSnapshot({
      mode: 'full', asOf: NOW, previousCheckpoint: BEFORE,
      membershipIds: [1], changedIds: [], cachedIds: [1, 2],
    });
    const snapshot = mergeThriveSnapshot({
      plan, previous, details: [{ asOf: NOW, record: { ...item(1), revision: 2, title: 'Reconciled fixture' } }],
      stateMetadata: metadata, membershipComplete: true, detailsComplete: true,
    });
    expect(snapshot.records).toEqual([{ ...item(1), revision: 2, title: 'Reconciled fixture', classification: 'OPEN' }]);
    expect(previous.records).toHaveLength(2);
  });

  it('retains scaffold types as tracked records rather than labelling them all task tickets', () => {
    const snapshot = full([{ ...item(1), type: 'Fixture Customer Scaffold' }]);
    expect(snapshot.records[0].type).toBe('Fixture Customer Scaffold');
    expect(snapshot.counts.unclassified).toBe(1);
  });

  it.each(['membershipComplete', 'detailsComplete'] as const)('rejects incomplete %s without mutating cache', (flag) => {
    const previous = full();
    const saved = structuredClone(previous);
    expect(() => mergeThriveSnapshot({
      plan: incremental(previous), previous, details: [], stateMetadata: metadata,
      membershipComplete: true, detailsComplete: true, [flag]: false,
    })).toThrow('Incomplete');
    expect(previous).toEqual(saved);
  });

  it('rejects missing, duplicate, foreign or current-time details', () => {
    const previous = full();
    const plan = incremental(previous, [1], [1]);
    for (const details of [
      [], [{ asOf: NOW, record: item(2) }],
      [{ asOf: BEFORE, record: item(1) }],
      [{ asOf: NOW, record: item(1) }, { asOf: NOW, record: item(1) }],
    ]) {
      expect(() => mergeThriveSnapshot({
        plan, previous, details, stateMetadata: metadata, membershipComplete: true, detailsComplete: true,
      })).toThrow();
    }
  });

  it('rejects stale cache bases and revision regressions', () => {
    const previous = full([{ ...item(1), revision: 2 }]);
    const plan = incremental(previous, [1], [1]);
    const input = {
      plan, previous, details: [{ asOf: NOW, record: item(1) }],
      stateMetadata: metadata, membershipComplete: true, detailsComplete: true,
    };
    expect(() => mergeThriveSnapshot(input)).toThrow('Revision regression');
    expect(() => mergeThriveSnapshot({ ...input, previous: { ...previous, checkpoint: NOW } })).toThrow('Stale');
  });

  it('drops upstream fields outside the normalized contract', () => {
    const snapshot = full([{ ...item(1), description: 'Not part of the output contract' } as ThriveRecord]);
    expect(snapshot.records[0]).not.toHaveProperty('description');
  });

  it('rejects duplicate metadata rather than guessing a classification', () => {
    const previous = full();
    expect(() => mergeThriveSnapshot({
      plan: incremental(previous), previous, details: [], stateMetadata: [...metadata, ...metadata],
      membershipComplete: true, detailsComplete: true,
    })).toThrow('Duplicate state metadata');
  });
});
