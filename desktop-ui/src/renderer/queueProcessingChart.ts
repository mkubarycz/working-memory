import type { ToolQueueSnapshot } from '../../../control-plane/src/diagnosticContract';
import { DIAGNOSTICS_BUCKET_MS, normalizedDiagnosticsChart } from './diagnosticsChart';

const metrics = [
  { key: 'depth', label: 'Average queue depth', unit: 'waiting', color: '#417ac2', dash: '' },
  { key: 'peak', label: 'Peak waiting', unit: 'waiting', color: '#a66a1d', dash: '4 3', aggregation: 'max' },
  { key: 'rate', label: 'Average processed / sec', unit: 'items / sec', color: '#23866b', dash: '' },
] as const;

export function queueProcessingChart(snapshot: ToolQueueSnapshot, bucketMs = DIAGNOSTICS_BUCKET_MS) {
  const points = snapshot.history.filter(sample => sample.at < snapshot.observedAt).map(sample => ({
    at: sample.at, bootId: sample.bootId, depth: sample.queueDepth,
    peak: sample.peakQueueDepth, rate: sample.processing?.processedPerSecond,
  })).concat({
    at: snapshot.observedAt, bootId: snapshot.bootId, depth: snapshot.waiting,
    peak: undefined, rate: snapshot.processing?.processedPerSecond,
  });
  return normalizedDiagnosticsChart(points, metrics, 15000, bucketMs);
}
