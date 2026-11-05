import { expect, it } from 'vitest';
import { httpDiagnosticsChart } from '../src/renderer/httpDiagnosticsChart';

it('normalizes each metric to its own window peak while retaining raw values and sorting without mutation', () => {
  const minutes = [
    { at: 60000, transactions: 1000, errors: 1, averageMs: 200, maxMs: 8000 },
    { at: 0, transactions: 500, errors: 4, averageMs: 100, maxMs: 4000 },
  ];
  const chart = httpDiagnosticsChart(minutes);
  expect(chart.series.map(series => series.peak)).toEqual([1000, 4, 200, 8000]);
  expect(chart.series.map(series => series.points.map(point => point.normalized))).toEqual([
    [50, 100], [100, 25], [50, 100], [50, 100],
  ]);
  expect(chart.series[0].points.map(point => point.value)).toEqual([500, 1000]);
  expect(minutes.map(minute => minute.at)).toEqual([60000, 0]);
});

it('keeps zero-valued series on the baseline without NaN or infinite coordinates', () => {
  const chart = httpDiagnosticsChart([{ at: 60000, transactions: 42, errors: 0, averageMs: 0, maxMs: 0 }]);
  for (const series of chart.series.slice(1)) {
    expect(series.peak).toBe(0);
    expect(series.points[0]).toMatchObject({ normalized: 0, value: 0 });
  }
});

it('uses actual elapsed time and breaks traces across missing minutes instead of inventing samples', () => {
  const chart = httpDiagnosticsChart([0, 60000, 180000].map(at => ({
    at, transactions: 10, errors: 1, averageMs: 20, maxMs: 100,
  })));
  expect(chart.series[0].points).toHaveLength(3);
  expect(chart.series[0].points.map(point => point.breakBefore)).toEqual([true, false, true]);
  expect(chart.series[0].points.map(point => point.at)).toEqual([30000, 90000, 210000]);
});

it('represents no data explicitly and handles an isolated sample with a finite time range', () => {
  const empty = httpDiagnosticsChart([]);
  expect(empty.hasData).toBe(false);
  expect(empty.series.every(series => series.points.length === 0)).toBe(true);
  const single = httpDiagnosticsChart([{ at: 123000, transactions: 1, errors: 0, averageMs: 3, maxMs: 3 }]);
  expect(single.hasData).toBe(true);
  expect(single.end - single.start).toBe(60000);
  expect(single.series[0].points[0].at).toBe(150000);
});
