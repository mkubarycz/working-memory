import type { ToolQueueSnapshot } from '../../../control-plane/src/diagnosticContract';
import { DIAGNOSTICS_BUCKET_MS, type DiagnosticsChartData, type DiagnosticsChartPoint } from './diagnosticsChart';

const metrics = [
  { key: 'timeouts', label: 'Sum Queue Timeouts', color: '#a66a1d' },
  { key: 'rejections', label: 'Sum Rejections', color: '#c4518b' },
  { key: 'shutdown', label: 'Sum Shutdown Drops', color: '#805ec0' },
] as const;

export function queueDropsChart(snapshot: ToolQueueSnapshot, range: Pick<DiagnosticsChartData, 'start' | 'end'>,
  bucketMs = DIAGNOSTICS_BUCKET_MS): DiagnosticsChartData {
  const samples = new Map<string, Pick<ToolQueueSnapshot, 'bootId' | 'queueDrops'> & { at: number }>();
  for (const sample of [...snapshot.history].reverse()) {
    if (sample.at <= snapshot.observedAt) samples.set(`${sample.bootId}:${sample.at}`, sample);
  }
  samples.set(`${snapshot.bootId}:${snapshot.observedAt}`, { at: snapshot.observedAt, bootId: snapshot.bootId, queueDrops: snapshot.queueDrops });
  const ordered = [...samples.values()].sort((a, b) => a.at - b.at);
  const buckets = new Map<number, { from: number; to: number; counts: { timeouts: number; rejections: number; shutdown: number } }>();
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1], current = ordered[index];
    if (previous.bootId !== current.bootId || !previous.queueDrops || !current.queueDrops) continue;
    const counts = {
      timeouts: current.queueDrops.timeouts - previous.queueDrops.timeouts,
      rejections: current.queueDrops.rejections - previous.queueDrops.rejections,
      shutdown: current.queueDrops.shutdown - previous.queueDrops.shutdown,
    };
    if (Object.values(counts).some(count => count < 0)) continue;
    const at = Math.floor((current.at - 1) / bucketMs) * bucketMs + bucketMs / 2;
    const bucket = buckets.get(at) ?? { from: previous.at, to: current.at, counts: { timeouts: 0, rejections: 0, shutdown: 0 } };
    bucket.to = current.at;
    for (const metric of metrics) bucket.counts[metric.key] += counts[metric.key];
    buckets.set(at, bucket);
  }
  return {
    ...range, bucketMs, hasData: buckets.size > 0,
    series: metrics.map(metric => {
      const points: DiagnosticsChartPoint[] = [...buckets].map(([at, bucket]) => ({
        at, from: bucket.from, to: bucket.to, value: bucket.counts[metric.key], normalized: null, breakBefore: true,
      }));
      return { ...metric, unit: 'drops', dash: '', peak: Math.max(0, ...points.map(point => point.value ?? 0)), points };
    }),
  };
}
