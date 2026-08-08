/**
 * Unit coverage for the pure alert-callout shaping helper used by the document
 * editor's workstream + topic views (WM 14.2 alerts-on-document-views). No DB,
 * no VS Code, no client — just the scope/dim/sort logic.
 */

import { describe, test, expect } from 'vitest';
import {
  buildAlertVMs,
  alertBubbleForTopic,
  RECENT_CLOSED_ALERT_MS,
} from '../src/webview/alertVms';
import type { Alert } from '../src/controlPlaneClient';

const NOW = 1_000_000_000_000;

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
    const vms = buildAlertVMs(alerts, ['t1'], NOW);
    expect(vms.map((v) => v.id)).toEqual(['in']);
  });

  test('intersects against multiple member slugs (workstream scope)', () => {
    const alerts = [
      alert({ id: 'a', topics: ['t2'] }),
      alert({ id: 'b', topics: ['t9'] }),
    ];
    const vms = buildAlertVMs(alerts, ['t1', 't2', 't3'], NOW);
    expect(vms.map((v) => v.id)).toEqual(['a']);
  });

  test('hides a closed alert older than the recent window', () => {
    const stale = alert({
      id: 'stale',
      status: 'closed',
      updated_at: NOW - RECENT_CLOSED_ALERT_MS - 1,
    });
    expect(buildAlertVMs([stale], ['t1'], NOW)).toEqual([]);
  });

  test('keeps a recently-closed alert but marks it dimmed', () => {
    const recent = alert({
      id: 'recent',
      status: 'closed',
      updated_at: NOW - 1000,
    });
    const vms = buildAlertVMs([recent], ['t1'], NOW);
    expect(vms).toHaveLength(1);
    expect(vms[0].dimmed).toBe(true);
  });

  test('open alerts are never dimmed', () => {
    const vms = buildAlertVMs(
      [alert({ status: 'alert' }), alert({ id: 'i', status: 'informational' })],
      ['t1'],
      NOW,
    );
    expect(vms.every((v) => v.dimmed === false)).toBe(true);
  });

  test('orders active → informational → closed, newest-first within a tier', () => {
    const alerts = [
      alert({ id: 'closed', status: 'closed', updated_at: NOW - 500 }),
      alert({ id: 'info-old', status: 'informational', updated_at: NOW - 10 }),
      alert({ id: 'info-new', status: 'informational', updated_at: NOW - 5 }),
      alert({ id: 'active', status: 'alert', updated_at: NOW - 100 }),
    ];
    const vms = buildAlertVMs(alerts, ['t1'], NOW);
    expect(vms.map((v) => v.id)).toEqual([
      'active',
      'info-new',
      'info-old',
      'closed',
    ]);
  });

  test('derives a title from the first description line when title is blank', () => {
    const vms = buildAlertVMs(
      [alert({ title: '  ', description: 'first line\nsecond' })],
      ['t1'],
      NOW,
    );
    expect(vms[0].title).toBe('first line');
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
