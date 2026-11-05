import type { ToolQueueSnapshot } from '../../../control-plane/src/diagnosticContract';
import { DIAGNOSTICS_BUCKET_MS, type DiagnosticsChartData, type DiagnosticsChartPoint } from './diagnosticsChart';

const colors = ['#417ac2', '#a66a1d', '#23866b', '#a45082', '#7561ae', '#9c4d39', '#258794', '#737426'];

export function toolRequestsChart(snapshot: ToolQueueSnapshot, range: Pick<DiagnosticsChartData, 'start' | 'end'>): DiagnosticsChartData {
  const samples = [...snapshot.history.filter(sample => sample.at < snapshot.observedAt), {
    at: snapshot.observedAt, bootId: snapshot.bootId, requestsByTool: snapshot.requestsByTool,
  }].sort((a, b) => a.at - b.at);
  const intervals = samples.flatMap((sample, index) => {
    const previous = samples[index - 1];
    if (!previous || previous.bootId !== sample.bootId || previous.at >= sample.at
      || !previous.requestsByTool || !sample.requestsByTool) return [];
    const counts = Object.entries(sample.requestsByTool).map(([operation, count]) =>
      [operation, count - (previous.requestsByTool?.[operation] ?? 0)] as const);
    if (counts.some(([, count]) => count < 0)) return [];
    return [{ from: previous.at, to: sample.at, counts: new Map(counts) }];
  });
  const tools = [...new Set(intervals.flatMap(interval =>
    [...interval.counts].filter(([, count]) => count > 0).map(([operation]) => operation)))].sort();
  const buckets = new Map<number, { from: number; to: number; counts: Map<string, number> }>();
  for (const interval of intervals) {
    const at = Math.floor((interval.to - 1) / DIAGNOSTICS_BUCKET_MS) * DIAGNOSTICS_BUCKET_MS + DIAGNOSTICS_BUCKET_MS / 2;
    const bucket = buckets.get(at) ?? { from: interval.from, to: interval.to, counts: new Map<string, number>() };
    bucket.to = interval.to;
    for (const [operation, count] of interval.counts) {
      bucket.counts.set(operation, (bucket.counts.get(operation) ?? 0) + count);
    }
    buckets.set(at, bucket);
  }
  return {
    ...range, hasData: intervals.length > 0,
    series: tools.map(operation => {
      const colorIndex = [...operation].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0) % colors.length;
      const points: DiagnosticsChartPoint[] = [...buckets].map(([at, bucket]) => ({
        at, from: bucket.from, to: bucket.to,
        value: bucket.counts.get(operation) ?? 0, normalized: null, breakBefore: true,
      }));
      return {
        key: operation, label: operation, unit: 'requests', color: colors[colorIndex], dash: '',
        peak: Math.max(0, ...points.map(point => point.value ?? 0)), points,
      };
    }),
  };
}
