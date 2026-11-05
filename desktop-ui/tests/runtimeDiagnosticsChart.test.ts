import { expect, it } from 'vitest';
import type { InstanceDiagnostics } from '../../control-plane/src/diagnosticContract';
import { runtimeDiagnosticsChart } from '../src/renderer/runtimeDiagnosticsChart';

type Sample = NonNullable<InstanceDiagnostics['samples']>[number];
const sample = (at: number, overrides: Partial<Sample> = {}): Sample => ({
  at, bootId: '00000000-0000-4000-8000-000000000001',
  heapUsedBytes: 50 * 1048576, heapLimitBytes: 200 * 1048576, rssBytes: 100 * 1048576,
  externalBytes: 20 * 1048576, arrayBufferBytes: 0, cpuPercent: 40,
  eventLoopMaxMs: 20, gcCount: 2, gcDurationMs: 10, queueDepth: 4, runningTools: 2,
  operations: [], ...overrides,
});

it('normalizes all nine former table metrics independently and retains memory in MiB without mutating samples', () => {
  const samples = [
    sample(10000, { heapUsedBytes: 100 * 1048576, rssBytes: 200 * 1048576,
      externalBytes: 40 * 1048576, cpuPercent: 80, eventLoopMaxMs: 40,
      gcCount: 4, gcDurationMs: 20, queueDepth: 8, runningTools: 4 }),
    sample(0),
    sample(60000),
  ];
  const chart = runtimeDiagnosticsChart(samples);
  expect(chart.series.map(series => series.peak)).toEqual([75, 150, 30, 60, 40, 6, 30, 6, 3]);
  expect(chart.series.map(series => series.points.map(point => point.value))).toEqual([
    [75, 50], [150, 100], [30, 20], [60, 40], [40, 20], [6, 2], [30, 10], [6, 4], [3, 2],
  ]);
  for (const series of chart.series) {
    expect(series.points[0].normalized).toBe(100);
    expect(series.points[1].normalized).toBeCloseTo((series.points[1].value ?? 0) / series.peak * 100);
  }
  expect(chart.series[0]).toMatchObject({ label: 'Heap', unit: 'MiB' });
  expect(chart.series[0].points.map(point => point.value)).toEqual([75, 50]);
  expect(samples.map(item => item.at)).toEqual([10000, 0, 60000]);
});

it('allows sampling jitter but breaks traces across missing samples and backend restarts', () => {
  const chart = runtimeDiagnosticsChart([
    sample(50000), sample(60010), sample(70000), sample(180000),
    sample(240000, { bootId: '00000000-0000-4000-8000-000000000002' }),
  ]);
  for (const series of chart.series) {
    expect(series.points.map(point => point.breakBefore)).toEqual([true, false, true, true]);
  }
  expect(chart.series[0].points[1].at).toBe(90000);
});

it('keeps zero-valued metrics on the baseline with finite coordinates', () => {
  const chart = runtimeDiagnosticsChart([sample(0, {
    heapUsedBytes: 0, rssBytes: 0, externalBytes: 0, cpuPercent: 0,
    eventLoopMaxMs: 0, gcCount: 0, gcDurationMs: 0, queueDepth: 0, runningTools: 0,
  })]);
  for (const series of chart.series) {
    expect(series.peak).toBe(0);
    expect(series.points[0]).toMatchObject({ normalized: 0, value: 0 });
  }
});

it('handles empty or legacy history and isolated samples explicitly', () => {
  for (const samples of [undefined, []]) {
    const chart = runtimeDiagnosticsChart(samples);
    expect(chart.hasData).toBe(false);
    expect(chart.series.every(series => series.points.length === 0)).toBe(true);
  }
  const chart = runtimeDiagnosticsChart([sample(123000)]);
  expect(chart.hasData).toBe(true);
  expect(chart).toMatchObject({ start: 120000, end: 180000 });
  expect(chart.series[0].points[0].at).toBe(150000);
});
