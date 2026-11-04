import type { ToolQueueSnapshot } from '../../../control-plane/src/diagnosticContract';

export function queueProcessingChart(snapshot: ToolQueueSnapshot) {
  const points = [...snapshot.history].sort((a, b) => a.at - b.at)
    .filter(sample => sample.at < snapshot.observedAt)
    .map(sample => ({
      at: sample.at, bootId: sample.bootId, depth: sample.queueDepth,
      peak: sample.peakQueueDepth ?? sample.queueDepth, rate: sample.processing?.processedPerSecond,
    })).concat({
      at: snapshot.observedAt, bootId: snapshot.bootId, depth: snapshot.waiting,
      peak: snapshot.waiting, rate: snapshot.processing?.processedPerSecond,
    });
  const maxRate = Math.max(1, ...points.map(point => point.rate ?? 0));
  const first = points[0].at, last = points.at(-1)!.at;
  const x = (at: number) => 40 + (at - first) / Math.max(1, last - first) * 700;
  const depthLine = (field: 'depth' | 'peak') => points.map(point =>
    `${x(point.at)},${140 - point[field] / Math.max(1, snapshot.limits.waiting) * 120}`).join(' ');
  const processingPath = points.map((point, index) => {
    if (point.rate === undefined) return '';
    const previous = points[index - 1];
    const move = !previous || previous.rate === undefined || previous.bootId !== point.bootId
      || point.at - previous.at > 15000;
    return `${move ? 'M' : 'L'}${x(point.at)},${140 - point.rate / maxRate * 120}`;
  }).filter(Boolean).join(' ');
  return {
    points, maxRate, depthLine: depthLine('depth'), peakLine: depthLine('peak'), processingPath,
    processingPoints: points.flatMap(point => point.rate === undefined ? [] : [{
      at: point.at, value: point.rate, x: x(point.at), y: 140 - point.rate / maxRate * 120,
    }]),
  };
}
