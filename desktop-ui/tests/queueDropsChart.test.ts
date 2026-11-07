import { expect, it } from 'vitest';
import type { ToolQueueSnapshot } from '../../control-plane/src/diagnosticContract';
import { queueDropsChart } from '../src/renderer/queueDropsChart';
import { queueProcessingChart } from '../src/renderer/queueProcessingChart';
import { diagnosticsChartOption } from '../src/renderer/diagnosticsECharts';

function snapshot(): ToolQueueSnapshot {
  return {
    bootId: 'boot', observedAt: 80000, limits: { running: 4, waiting: 16, waitMs: 5000 },
    memoryBlocked: false, running: 0, waiting: 0, items: [], events: [],
    queueDrops: { timeouts: 7, rejections: 10, shutdown: 2 },
    history: [
      { at: 60000, bootId: 'boot', queueDepth: 0, runningTools: 0, queueDrops: { timeouts: 4, rejections: 8, shutdown: 1 } },
      { at: 10000, bootId: 'boot', queueDepth: 0, runningTools: 0, queueDrops: { timeouts: 1, rejections: 2, shutdown: 0 } },
    ],
  };
}

it('sums sampled drop deltas with raw counts, matching Queue Processing bounds and bucket selection', () => {
  const input = snapshot(), range = queueProcessingChart(input);
  const chart = queueDropsChart(input, range);
  expect(chart).toMatchObject({ start: range.start, end: range.end, bucketMs: 60000, hasData: true });
  expect(chart.series.map(series => series.points.map(point => point.value))).toEqual([[3, 3], [6, 2], [1, 1]]);
  expect(chart.series[0].points).toMatchObject([
    { at: 30000, from: 10000, to: 60000 }, { at: 90000, from: 60000, to: 80000 },
  ]);
  const wider = queueDropsChart(input, queueProcessingChart(input, 120000), 120000);
  expect(wider.series.map(series => series.points[0].value)).toEqual([6, 8, 2]);
  expect(diagnosticsChartOption(wider, null, true, false).series).toMatchObject([
    { id: 'timeouts', type: 'bar', data: [[60000, 6]] },
    { id: 'rejections', type: 'bar', data: [[60000, 8]] },
    { id: 'shutdown', type: 'bar', data: [[60000, 2]] },
  ]);
});

it('preserves old-boot shutdown intervals without differencing across restarts or inventing unavailable history', () => {
  const input = snapshot();
  input.bootId = 'next-boot';
  input.queueDrops = { timeouts: 0, rejections: 0, shutdown: 0 };
  const chart = queueDropsChart(input, queueProcessingChart(input));
  expect(chart.series.map(series => series.points.map(point => point.value))).toEqual([[3], [6], [1]]);
  input.history = [input.history[0]];
  expect(queueDropsChart(input, queueProcessingChart(input)).hasData).toBe(false);
  input.bootId = 'boot';
  expect(queueDropsChart(input, queueProcessingChart(input)).hasData).toBe(false);
  input.history[0].queueDrops = undefined;
  expect(queueDropsChart(input, queueProcessingChart(input)).hasData).toBe(false);
});

it('keeps the newest duplicate timestamp, including a final shutdown sample, without counting it twice', () => {
  const input = snapshot();
  input.history.splice(1, 0, { ...input.history[0], queueDrops: { timeouts: 1, rejections: 2, shutdown: 0 } });
  const chart = queueDropsChart(input, queueProcessingChart(input));
  expect(chart.series.map(series => series.points.reduce((sum, point) => sum + (point.value ?? 0), 0))).toEqual([6, 8, 2]);
});

it('retains shutdown drops when a restart sample has the same timestamp as the previous boot final sample', () => {
  const input = snapshot();
  input.bootId = 'next-boot';
  input.queueDrops = { timeouts: 0, rejections: 0, shutdown: 0 };
  input.history.unshift({ ...input.history[0], bootId: 'next-boot', queueDrops: input.queueDrops });
  const chart = queueDropsChart(input, queueProcessingChart(input));
  expect(chart.series.map(series => series.points.reduce((sum, point) => sum + (point.value ?? 0), 0))).toEqual([3, 6, 1]);
});
