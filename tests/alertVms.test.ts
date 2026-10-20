/**
 * Unit coverage for the pure alert-callout shaping helper used by the document
 * editor's workstream + topic views (WM 14.2 alerts-on-document-views). No DB,
 * no VS Code, no client — just the scope/dim/sort logic.
 */

import { describe, test, expect } from 'vitest';
import {
  buildAlertVMs,
  buildAlertHistoryVMs,
  alertBubbleForTopic,
} from '../shared/viewModels/alertVms';
import type { Alert } from '../shared/controlPlaneClient';

// Control-plane `updated_at` values are epoch SECONDS (see control-plane store).
const NOW = 1_000_000_000;

function alert(over: Partial<Alert>): Alert {
  return {
    id: 'a1',
    slug: null,
    title: 'Title',
    description: 'Desc',
    recommended_action: '',
    status: 'alert',
    dedupe_key: null,
    created_by: 'system',
    topics: ['t1'],
    created_at: NOW,
    updated_at: NOW,
    resourceVersion: 1,
    ...over,
  };
}

describe('buildAlertVMs', () => {
  test('keeps only alerts whose topics intersect the scope', () => {
    const alerts = [
      alert({ id: 'in', topics: ['t1', 'x'] }),
      alert({ id: 'out', topics: ['y', 'z'] }),
    ];
    const vms = buildAlertVMs(alerts, ['t1']);
    expect(vms.map((v) => v.id)).toEqual(['in']);
  });

  test('intersects against multiple member slugs (workstream scope)', () => {
    const alerts = [
      alert({ id: 'a', topics: ['t2'] }),
      alert({ id: 'b', topics: ['t9'] }),
    ];
    const vms = buildAlertVMs(alerts, ['t1', 't2', 't3']);
    expect(vms.map((v) => v.id)).toEqual(['a']);
  });

  test('excludes closed alerts from the open callouts', () => {
    const vms = buildAlertVMs(
      [
        alert({ id: 'open', status: 'alert' }),
        alert({ id: 'closed', status: 'closed', updated_at: NOW }),
      ],
      ['t1'],
    );
    expect(vms.map((v) => v.id)).toEqual(['open']);
  });

  test('open alerts are never dimmed', () => {
    const vms = buildAlertVMs(
      [alert({ status: 'alert' }), alert({ id: 'i', status: 'informational' })],
      ['t1'],
    );
    expect(vms.every((v) => v.dimmed === false)).toBe(true);
  });

  test('orders active → informational, newest-first then id within a tier', () => {
    const alerts = [
      alert({ id: 'closed', status: 'closed', updated_at: NOW - 500 }),
      alert({ id: 'info-old', status: 'informational', updated_at: NOW - 10 }),
      alert({ id: 'info-new-b', status: 'informational', updated_at: NOW - 5 }),
      alert({ id: 'info-new-a', status: 'informational', updated_at: NOW - 5 }),
      alert({ id: 'active', status: 'alert', updated_at: NOW - 100 }),
    ];
    const vms = buildAlertVMs(alerts, ['t1']);
    expect(vms.map((v) => v.id)).toEqual([
      'active',
      'info-new-a',
      'info-new-b',
      'info-old',
    ]);
  });

  test('derives a title from the first description line when title is blank', () => {
    const vms = buildAlertVMs(
      [alert({ title: '  ', description: 'first line\nsecond' })],
      ['t1'],
    );
    expect(vms[0].title).toBe('first line');
  });
});

describe('buildAlertHistoryVMs', () => {
  test('a just-closed alert appears in history immediately (seconds timestamps)', () => {
    const closed = alert({ id: 'just-closed', status: 'closed', updated_at: NOW });
    expect(buildAlertVMs([closed], ['t1'])).toEqual([]);
    const history = buildAlertHistoryVMs([closed], ['t1']);
    expect(history).toMatchObject([{ id: 'just-closed', status: 'closed', dimmed: true }]);
  });

  test('keeps older closed alerts with no recency cutoff', () => {
    const history = buildAlertHistoryVMs(
      [alert({ id: 'ancient', status: 'closed', updated_at: 1 })],
      ['t1'],
    );
    expect(history.map((v) => v.id)).toEqual(['ancient']);
  });

  test('contains only closed alerts in scope (workstream member slugs)', () => {
    const alerts = [
      alert({ id: 'member', status: 'closed', topics: ['t2'] }),
      alert({ id: 'outsider', status: 'closed', topics: ['t9'] }),
      alert({ id: 'open', status: 'alert', topics: ['t2'] }),
      alert({ id: 'info', status: 'informational', topics: ['t1'] }),
    ];
    expect(buildAlertHistoryVMs(alerts, ['t1', 't2']).map((v) => v.id)).toEqual(['member']);
  });

  test('orders most recently closed first, then by id for ties', () => {
    const alerts = [
      alert({ id: 'old', status: 'closed', updated_at: NOW - 86_400 * 365 }),
      alert({ id: 'tie-b', status: 'closed', updated_at: NOW - 60 }),
      alert({ id: 'newest', status: 'closed', updated_at: NOW }),
      alert({ id: 'tie-a', status: 'closed', updated_at: NOW - 60 }),
    ];
    expect(buildAlertHistoryVMs(alerts, ['t1']).map((v) => v.id)).toEqual([
      'newest',
      'tie-a',
      'tie-b',
      'old',
    ]);
  });
});

describe('alertBubbleForTopic', () => {
  test('counts only OPEN alerts referencing the slug', () => {
    const alerts = [
      alert({ id: 'a', status: 'alert', topics: ['t1'] }),
      alert({ id: 'i', status: 'informational', topics: ['t1'] }),
      alert({ id: 'closed', status: 'closed', topics: ['t1'] }),
      alert({ id: 'other', status: 'alert', topics: ['t2'] }),
    ];
    expect(alertBubbleForTopic(alerts, 't1').count).toBe(2);
  });

  test("severity is 'alert' when any open alert is actionable", () => {
    const alerts = [
      alert({ id: 'i', status: 'informational', topics: ['t1'] }),
      alert({ id: 'a', status: 'alert', topics: ['t1'] }),
    ];
    expect(alertBubbleForTopic(alerts, 't1').severity).toBe('alert');
  });

  test("severity is 'informational' when only informational alerts are open", () => {
    const alerts = [alert({ status: 'informational', topics: ['t1'] })];
    expect(alertBubbleForTopic(alerts, 't1').severity).toBe('informational');
  });

  test('empty bubble when nothing open references the slug', () => {
    const b = alertBubbleForTopic([alert({ topics: ['x'] })], 't1');
    expect(b).toEqual({ count: 0, severity: null });
  });
});
