import { expect, it } from 'vitest';
import type { ToolQueueSnapshot } from '../../control-plane/src/diagnosticContract';
import { toolQueueRequests, topQueueRequests } from '../src/renderer/toolQueueRequests';

type Event = ToolQueueSnapshot['events'][number];
const event = (overrides: Partial<Event> = {}): Event => ({
  sequence: 3, at: 1500, requestId: 'request-1', operation: 'wm-document-read',
  caller: 'owner', event: 'completed', waiting: 0, running: 0, waitMs: 100, runMs: 400,
  ...overrides,
});

it('collapses lifecycle events into one row with queued-to-finished timings regardless of input order', () => {
  const events = [
    event({ sequence: 2, at: 1100, event: 'started', runMs: 0 }),
    event(),
    event({ sequence: 1, at: 1000, event: 'queued', waitMs: 0, runMs: 0 }),
  ];
  expect(toolQueueRequests({ events, items: [], observedAt: 9000 })).toEqual([{
    requestId: 'request-1', operation: 'wm-document-read', caller: 'owner',
    queuedAt: 1000, durationMs: 500, waitMs: 100, runMs: 400, state: 'Completed',
  }]);
  expect(events.map(item => item.sequence)).toEqual([2, 3, 1]);
});

it('recovers complete timings from a terminal event even when earlier lifecycle events have aged out', () => {
  expect(toolQueueRequests({ events: [event()], items: [], observedAt: 9000 })[0])
    .toMatchObject({ queuedAt: 1000, durationMs: 500, waitMs: 100, runMs: 400 });
});

it('shows live elapsed timings even when live requests have no recent lifecycle records', () => {
  const rows = toolQueueRequests({
    events: [event({ event: 'queued', sequence: 1, at: 1000, waitMs: 0, runMs: 0 })],
    items: [
      { requestId: 'request-1', operation: 'wm-document-read', caller: 'owner', queuedAt: 1000, startedAt: 1100 },
      { requestId: 'request-2', operation: 'wm-document-query', caller: 'client:123', queuedAt: 1200 },
    ], observedAt: 1500,
  });
  expect(rows).toEqual([
    { requestId: 'request-2', operation: 'wm-document-query', caller: 'client:123',
      queuedAt: 1200, durationMs: 300, waitMs: 300, runMs: 0, state: 'Waiting' },
    { requestId: 'request-1', operation: 'wm-document-read', caller: 'owner',
      queuedAt: 1000, durationMs: 500, waitMs: 100, runMs: 400, state: 'Running' },
  ]);
});

it.each(['full', 'expired', 'cancelled', 'shutdown', 'not_executed'])('preserves %s as not executed instead of a successful completion', outcome => {
  const [row] = toolQueueRequests({
    events: [event({ event: outcome, runMs: 0 })], items: [], observedAt: 9000,
  });
  expect(row.state).toContain('(not executed)');
  expect(row).toMatchObject({ durationMs: 100, waitMs: 100, runMs: 0 });
});

it('preserves failed execution and its timings', () => {
  const [row] = toolQueueRequests({ events: [event({ event: 'failed' })], items: [], observedAt: 9000 });
  expect(row).toMatchObject({ state: 'Failed', durationMs: 500, waitMs: 100, runMs: 400 });
});

it('does not invent completion or indefinitely advancing timings for interrupted or unavailable outcomes', () => {
  for (const code of ['queued', 'started', 'future-event']) {
    const [row] = toolQueueRequests({ events: [event({ event: code })], items: [], observedAt: 99999 });
    expect(row).toMatchObject({ state: 'Outcome unavailable', durationMs: null, waitMs: null, runMs: null });
  }
});

it('orders rows by queue-entry time with stable IDs for ties and handles empty history', () => {
  expect(toolQueueRequests({ events: [], items: [], observedAt: 1000 })).toEqual([]);
  const rows = toolQueueRequests({
    events: [
      event({ requestId: 'b' }), event({ requestId: 'a' }),
      event({ requestId: 'c', at: 2000, waitMs: 0, runMs: 0 }),
    ], items: [], observedAt: 9999,
  });

  expect(rows.map(row => row.requestId)).toEqual(['c', 'a', 'b']);
});

it('ranks the top 50 by wait or runtime without mutating the log or including unavailable timings', () => {
  const rows = toolQueueRequests({
    events: Array.from({ length: 60 }, (_, i) => event({ requestId: String(i), waitMs: i, runMs: 60 - i })),
    items: [], observedAt: 9999,
  });
  const original = rows.map(row => row.requestId);
  rows.push({ ...rows[0], requestId: 'unknown', waitMs: null, runMs: null });
  expect(topQueueRequests(rows, 'waitMs')).toHaveLength(50);
  expect(topQueueRequests(rows, 'waitMs')[0].requestId).toBe('59');
  expect(topQueueRequests(rows, 'runMs')[0].requestId).toBe('0');
  expect(topQueueRequests(rows, 'waitMs').some(row => row.requestId === 'unknown')).toBe(false);
  expect(rows.slice(0, 60).map(row => row.requestId)).toEqual(original);
});
