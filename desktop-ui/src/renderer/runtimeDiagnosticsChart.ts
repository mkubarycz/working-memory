import type { InstanceDiagnostics } from '../../../control-plane/src/diagnosticContract';
import { normalizedDiagnosticsChart } from './diagnosticsChart';

const metrics = [
  { key: 'heapUsedBytes', label: 'Heap', unit: 'MiB', color: '#6ea8fe', dash: '', divisor: 1048576 },
  { key: 'rssBytes', label: 'RSS', unit: 'MiB', color: '#d9ac68', dash: '4 3', divisor: 1048576 },
  { key: 'externalBytes', label: 'External memory', unit: 'MiB', color: '#67c9a5', dash: '8 3', divisor: 1048576 },
  { key: 'cpuPercent', label: 'CPU', unit: '%', color: '#f08080', dash: '2 3' },
  { key: 'eventLoopMaxMs', label: 'Event-loop max', unit: 'ms', color: '#c4a0f5', dash: '' },
  { key: 'gcCount', label: 'GC count', unit: '/sample', color: '#71d4e0', dash: '4 3' },
  { key: 'gcDurationMs', label: 'GC duration', unit: 'ms', color: '#f5a4ce', dash: '8 3' },
  { key: 'queueDepth', label: 'Waiting tools', unit: 'tools', color: '#d0d77b', dash: '2 3' },
  { key: 'runningTools', label: 'Running tools', unit: 'tools', color: '#b8c2ce', dash: '8 3 2 3' },
] as const;

export function runtimeDiagnosticsChart(samples: InstanceDiagnostics['samples']) {
  return normalizedDiagnosticsChart(samples ?? [], metrics, 10000, 15000);
}
