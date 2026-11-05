import { expect, it } from 'vitest';
import type { ToolQueueSnapshot } from '../../control-plane/src/diagnosticContract';
import { queueProcessingChart } from '../src/renderer/queueProcessingChart';
import { toolRequestsChart } from '../src/renderer/toolRequestsChart';
import { diagnosticsChartOption } from '../src/renderer/diagnosticsECharts';

const processing = (rate: number) => ({
  processedPerSecond: rate, processedLastMinute: 30, averageWaitMs: 12.5, averageRunMs: 40,
});
const snapshot = (): ToolQueueSnapshot => ({
  bootId: 'boot', observedAt: 20000, limits: { running: 4, waiting: 16, waitMs: 5000 },
  memoryBlocked: false, waiting: 4, running: 1, items: [], events: [],
  processing: processing(10), requestsByTool: { read: 12, query: 5 },
  history: [{ at: 10000, bootId: 'boot', queueDepth: 8, peakQueueDepth: 12, runningTools: 1,
    requestsByTool: { read: 9, query: 1 }, processing: processing(5) }],
});

it('aggregates minute averages and maximum waiting before independently normalizing each metric', () => {
  const input = snapshot(), chart = queueProcessingChart(input);
  expect(chart.series.map(series => series.peak)).toEqual([6, 12, 7.5]);
  expect(chart.series.map(series => series.points.map(point => point.normalized))).toEqual([
    [100], [100], [100],
  ]);
  expect(chart.series[0].points[0]).toMatchObject({ at: 30000, from: 0, to: 60000, value: 6 });
  expect(input.history).toHaveLength(1);
});

it('breaks traces across missing data, sampling gaps and restarts without fabricating missing throughput or peaks', () => {
  const input = snapshot();
  input.observedAt = 130000; input.bootId = 'new-boot';
  input.history = [
    { at: 90000, bootId: 'boot', queueDepth: 1, runningTools: 1, processing: processing(1) },
    { at: 30000, bootId: 'boot', queueDepth: 1, runningTools: 1, processing: processing(1) },
    { at: 10000, bootId: 'boot', queueDepth: 1, runningTools: 1, processing: processing(1) },
    { at: 20000, bootId: 'boot', queueDepth: 1, runningTools: 1 },
  ];
  const chart = queueProcessingChart(input);
  expect(chart.series[2].points.map(point => point.breakBefore)).toEqual([true, true, true]);
  expect(chart.series[2].points.map(point => point.value)).toEqual([1, 1, 10]);
  expect(chart.series[1].points.every(point => point.value === null)).toBe(true);
});

it('handles empty, zero-rate and legacy histories without duplicate timestamps', () => {
  const input = snapshot();
  input.history = [{ at: input.observedAt, bootId: input.bootId, queueDepth: 1, runningTools: 1 }];
  input.processing = processing(0);
  expect(queueProcessingChart(input).series[2].points).toMatchObject([{ value: 0, normalized: 0 }]);
  input.processing = undefined;
  expect(queueProcessingChart(input).series[2].points).toMatchObject([{ value: null, normalized: null }]);
});

it('uses cumulative request-count deltas rather than the truncated lifecycle log, with identical chart time ranges', () => {
  const input = snapshot(), range = queueProcessingChart(input), chart = toolRequestsChart(input, range);
  expect(chart).toMatchObject({ start: range.start, end: range.end, hasData: true });
  expect(chart.series.map(series => series.key)).toEqual(['query', 'read']);
  expect(chart.series.map(series => series.points[0])).toMatchObject([
    { at: 30000, from: 10000, to: 20000, value: 4 }, { value: 3 },
  ]);
  expect(input.events).toEqual([]);
});

it('does not bridge unknown data, reset counters, duplicate timestamps or backend restarts', () => {
  const input = snapshot(), range = queueProcessingChart(input);
  for (const change of [
    () => { input.history[0].requestsByTool = undefined; },
    () => { input.history[0].bootId = 'old-boot'; },
    () => { input.history[0].requestsByTool = { read: 100 }; },
  ]) {
    const fresh = snapshot();
    Object.assign(input, fresh);
    change();
    expect(toolRequestsChart(input, range).hasData).toBe(false);
  }
  input.history = []; input.requestsByTool = {};
  expect(toolRequestsChart(input, range).hasData).toBe(false);
});

it('sums sampled request deltas once per minute, including partial minutes and exact boundary endings', () => {
  const input = snapshot();
  input.observedAt = 80000;
  input.requestsByTool = { read: 30, query: 18 };
  input.history = [0, 10000, 30000, 60000, 70000].map((at, index) => ({
    at, bootId: input.bootId, queueDepth: 0, runningTools: 0,
    requestsByTool: { read: index * 6, query: index * 3 },
  }));
  const range = queueProcessingChart(input), chart = toolRequestsChart(input, range);
  expect(chart.series[0].points).toMatchObject([
    { at: 30000, from: 0, to: 60000, value: 9 },
    { at: 90000, from: 60000, to: 80000, value: 9 },
  ]);
  expect(chart.series[1].points.map(point => point.value)).toEqual([18, 12]);
  expect(chart.series[0].points.reduce((sum, point) => sum + (point.value ?? 0), 0)).toBe(18);
  expect(chart).toMatchObject({ start: 0, end: 120000 });
});

it('uses one point per minute even with six backend samples per minute', () => {
  const input = snapshot();
  input.observedAt = 110000;
  input.history = Array.from({ length: 11 }, (_, i) => ({
    at: i * 10000, bootId: input.bootId, queueDepth: i,
    peakQueueDepth: i + 2, runningTools: 0, processing: processing(i),
  }));
  const chart = queueProcessingChart(input);
  expect(chart.series.every(series => series.points.length === 2)).toBe(true);
  expect(chart.series[0].points.map(point => point.value)).toEqual([2.5, (6 + 7 + 8 + 9 + 10 + 4) / 6]);
  expect(chart.series[1].points.map(point => point.value)).toEqual([7, 12]);
  expect(chart.series[2].points[0].normalized).toBeCloseTo(30);
});

it('renders raw stacked counts and independently normalized lines through ECharts, filtering series without changing time bounds', () => {
  const input = snapshot(), chart = queueProcessingChart(input);
  const options = diagnosticsChartOption(chart, 'depth', false);
  expect(options.series).toMatchObject([{ id: 'depth', type: 'line', data: [[30000, 100]] }]);
  const stacked = diagnosticsChartOption(toolRequestsChart(input, chart), null, true);
  expect(stacked.series).toMatchObject([
    { id: 'query', type: 'bar', stack: 'requests', data: [[30000, 4]] },
    { id: 'read', type: 'bar', stack: 'requests', data: [[30000, 3]] },
  ]);
  expect(options.xAxis).toMatchObject({ type: 'time', min: chart.start, max: chart.end, minInterval: 60000 });
  expect(stacked.xAxis).toMatchObject({ type: 'time', min: chart.start, max: chart.end, minInterval: 60000 });
  expect(stacked.grid).toEqual(options.grid);
});
