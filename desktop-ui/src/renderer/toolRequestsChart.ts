import type { ToolQueueSnapshot } from '../../../control-plane/src/diagnosticContract';
import { DIAGNOSTICS_BUCKET_MS, type DiagnosticsChartData, type DiagnosticsChartPoint } from './diagnosticsChart';

const colors = ['#417ac2', '#a66a1d', '#23866b', '#a45082', '#7561ae', '#9c4d39', '#258794', '#737426'];

export function toolRequestsChart(snapshot: ToolQueueSnapshot, range: Pick<DiagnosticsChartData, 'start' | 'end'>,
  bucketMs = DIAGNOSTICS_BUCKET_MS, selectedTool: string | null = null): DiagnosticsChartData {
  const samples = [...snapshot.history.filter(sample => sample.at < snapshot.observedAt), {
    at: snapshot.observedAt, bootId: snapshot.bootId, requestsByTool: snapshot.requestsByTool, timingsByTool: snapshot.timingsByTool,
  }].sort((a, b) => a.at - b.at);
  const intervals = samples.flatMap((sample, index) => {
    const previous = samples[index - 1];
    if (!previous || previous.bootId !== sample.bootId || previous.at >= sample.at
      || !previous.requestsByTool || !sample.requestsByTool) return [];
    const counts = Object.entries(sample.requestsByTool).map(([operation, count]) =>
      [operation, count - (previous.requestsByTool?.[operation] ?? 0)] as const);
    if (counts.some(([, count]) => count < 0)) return [];
    let waitMs = 0, runMs = 0, executed = 0;
    let timingsKnown = previous.timingsByTool !== undefined && sample.timingsByTool !== undefined;
    for (const operation of new Set([...Object.keys(previous.timingsByTool ?? {}), ...Object.keys(sample.timingsByTool ?? {})])) {
      if (selectedTool !== null && operation !== selectedTool) continue;
      const before = previous.timingsByTool?.[operation] ?? { finished: 0, executed: 0, waitMs: 0, runMs: 0 };
      const after = sample.timingsByTool?.[operation] ?? { finished: 0, executed: 0, waitMs: 0, runMs: 0 };
      if (after.finished < before.finished || after.executed < before.executed || after.waitMs < before.waitMs || after.runMs < before.runMs) timingsKnown = false;
      waitMs += after.waitMs - before.waitMs;
      runMs += after.runMs - before.runMs;
      executed += after.executed - before.executed;
    }
    return [{ from: previous.at, to: sample.at, counts: new Map(counts), waitMs, runMs, executed, timingsKnown }];
  });
  const tools = [...new Set(intervals.flatMap(interval =>
    [...interval.counts].filter(([, count]) => count > 0).map(([operation]) => operation)))].sort();
  const buckets = new Map<number, { from: number; to: number; counts: Map<string, number>;
    waitMs: number; runMs: number; executed: number; timingsKnown: boolean }>();
  for (const interval of intervals) {
    const at = Math.floor((interval.to - 1) / bucketMs) * bucketMs + bucketMs / 2;
    const bucket = buckets.get(at) ?? { from: interval.from, to: interval.to, counts: new Map<string, number>(),
      waitMs: 0, runMs: 0, executed: 0, timingsKnown: true };
    bucket.to = interval.to;
    bucket.timingsKnown &&= interval.timingsKnown;
    bucket.waitMs += interval.waitMs;
    bucket.runMs += interval.runMs;
    bucket.executed += interval.executed;
    for (const [operation, count] of interval.counts) {
      bucket.counts.set(operation, (bucket.counts.get(operation) ?? 0) + count);
    }
    buckets.set(at, bucket);
  }
  return {
    ...range, bucketMs, hasData: intervals.length > 0,
    series: [...tools.map(operation => {
      const colorIndex = [...operation].reduce((hash, character) => (hash * 31 + character.charCodeAt(0)) >>> 0, 0) % colors.length;
      const points: DiagnosticsChartPoint[] = [...buckets].map(([at, bucket]) => ({
        at, from: bucket.from, to: bucket.to,
        value: bucket.counts.get(operation) ?? 0, normalized: null, breakBefore: true,
      }));
      return {
        key: operation, label: operation, unit: 'requests', color: colors[colorIndex], dash: '',
        peak: Math.max(0, ...points.map(point => point.value ?? 0)), points,
      };
    }), ...[
      { key: 'total-wait', label: 'Total wait time', color: '#c4518b' },
      { key: 'average-runtime', label: 'Average runtime', color: '#805ec0' },
    ].map(metric => {
      const entries = [...buckets];
      const points: DiagnosticsChartPoint[] = entries.map(([at, bucket], index) => ({
        at, from: bucket.from, to: bucket.to,
        breakBefore: !bucket.timingsKnown || !entries[index - 1]?.[1].timingsKnown || entries[index - 1]?.[1].to !== bucket.from,
        normalized: null,
        value: !bucket.timingsKnown ? null : metric.key === 'total-wait' ? bucket.waitMs
          : bucket.executed ? bucket.runMs / bucket.executed : null,
      }));
      const peak = Math.max(0, ...points.map(point => point.value ?? 0));
      for (const point of points) point.normalized = point.value === null ? null : peak === 0 ? 0 : point.value / peak * 100;
      return { ...metric, overlay: true, unit: 'ms', dash: '', peak, points };
    })],
  };
}
