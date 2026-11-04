import { expect, it } from 'vitest';
import type { InstanceDiagnostics } from '../../control-plane/src/diagnosticContract';
import { DIAGNOSTICS_CHART_BOUNDS } from '../src/renderer/diagnosticsChart';
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
  ];
  const chart = runtimeDiagnosticsChart(samples);
  expect(chart.series.map(series => series.peak)).toEqual([100, 200, 40, 80, 40, 4, 20, 8, 4]);
  expect(chart.series.map(series => series.points.map(point => point.normalized)))
    .toEqual(Array.from({ length: 9 }, () => [50, 100]));
  expect(chart.series[0]).toMatchObject({ label: 'Heap', unit: 'MiB' });
  expect(chart.series[0].points.map(point => point.value)).toEqual([50, 100]);
  expect(samples.map(item => item.at)).toEqual([10000, 0]);
});

it('allows sampling jitter but breaks traces across missing samples and backend restarts', () => {
  const chart = runtimeDiagnosticsChart([
    sample(0), sample(10010), sample(20000), sample(40000),
    sample(50000, { bootId: '00000000-0000-4000-8000-000000000002' }),
  ]);
  for (const series of chart.series) {
    expect(series.path.match(/[ML]/g)).toEqual(['M', 'L', 'L', 'M', 'M']);
  }
  expect(chart.series[0].points[1].x).toBeCloseTo(
    DIAGNOSTICS_CHART_BOUNDS.left
      + (DIAGNOSTICS_CHART_BOUNDS.right - DIAGNOSTICS_CHART_BOUNDS.left) * 10010 / 50000,
  );
});

it('keeps zero-valued metrics on the baseline with finite coordinates', () => {
  const chart = runtimeDiagnosticsChart([sample(0, {
    heapUsedBytes: 0, rssBytes: 0, externalBytes: 0, cpuPercent: 0,
    eventLoopMaxMs: 0, gcCount: 0, gcDurationMs: 0, queueDepth: 0, runningTools: 0,
  })]);
  for (const series of chart.series) {
    expect(series.peak).toBe(0);
    expect(series.points[0]).toMatchObject({ normalized: 0, y: DIAGNOSTICS_CHART_BOUNDS.bottom });
    expect(series.path).not.toMatch(/NaN|Infinity/);
  }
});

it('handles empty or legacy history and isolated samples explicitly', () => {
  for (const samples of [undefined, []]) {
    const chart = runtimeDiagnosticsChart(samples);
    expect(chart.hasData).toBe(false);
    expect(chart.series.every(series => series.path === '' && series.points.length === 0)).toBe(true);
  }
  const chart = runtimeDiagnosticsChart([sample(123000)]);
  expect(chart.hasData).toBe(true);
  expect(chart.end - chart.start).toBe(10000);
  expect(chart.series[0].points[0].x).toBe(DIAGNOSTICS_CHART_BOUNDS.left);
});
