import { expect, it } from 'vitest';
import type { ToolQueueSnapshot } from '../../control-plane/src/diagnosticContract';
import { queueProcessingChart } from '../src/renderer/queueProcessingChart';

const processing = (rate: number) => ({
  processedPerSecond: rate, processedLastMinute: 30, averageWaitMs: 12.5, averageRunMs: 40,
});
const snapshot = (): ToolQueueSnapshot => ({
  bootId: 'boot', observedAt: 20000, limits: { running: 4, waiting: 16, waitMs: 5000 },
  memoryBlocked: false, waiting: 4, running: 1, items: [], events: [],
  processing: processing(10),
  history: [{ at: 10000, bootId: 'boot', queueDepth: 8, peakQueueDepth: 12, runningTools: 1, processing: processing(5) }],
});

it('retains the depth/capacity axis and scales processed-per-second values on a separate right axis', () => {
  const input = snapshot();
  const chart = queueProcessingChart(input);
  expect(chart.depthLine).toBe('40,80 740,110');
  expect(chart.peakLine).toBe('40,50 740,110');
  expect(chart.processingPath).toBe('M40,80 L740,20');
  expect(chart.maxRate).toBe(10);
  expect(chart.processingPoints.map(point => point.value)).toEqual([5, 10]);
  expect(input.history).toHaveLength(1);
});

it('breaks processing traces for missing/legacy metrics, sampling gaps and restarts', () => {
  const input = snapshot();
  input.observedAt = 60000;
  input.bootId = 'new-boot';
  input.history = [
    { at: 30000, bootId: 'boot', queueDepth: 1, runningTools: 1, processing: processing(1) },
    { at: 10000, bootId: 'boot', queueDepth: 1, runningTools: 1, processing: processing(1) },
    { at: 20000, bootId: 'boot', queueDepth: 1, runningTools: 1 },
  ];
  expect(queueProcessingChart(input).processingPath.match(/[ML]/g)).toEqual(['M', 'M', 'M']);
  expect(input.history.map(sample => sample.at)).toEqual([30000, 10000, 20000]);
});

it('handles empty, zero-rate and legacy histories without inventing throughput or duplicate timestamps', () => {
  const input = snapshot();
  input.history = [];
  input.processing = processing(0);
  expect(queueProcessingChart(input)).toMatchObject({ maxRate: 1, processingPath: 'M40,140' });
  input.history = [{ at: input.observedAt, bootId: input.bootId, queueDepth: 1, runningTools: 1 }];
  expect(queueProcessingChart(input).points).toHaveLength(1);
  input.processing = undefined;
  expect(queueProcessingChart(input).processingPoints).toEqual([]);
  expect(queueProcessingChart(input).processingPath).toBe('');
});
