import type { InstanceDiagnostics } from '../../../control-plane/src/diagnosticContract';
import { normalizedDiagnosticsChart } from './diagnosticsChart';

const metrics = [
  { key: 'transactions', label: 'Transactions', unit: '/min', color: '#6ea8fe', dash: '' },
  { key: 'errors', label: 'Errors', unit: '/min', color: '#f08080', dash: '4 3' },
  { key: 'averageMs', label: 'Average duration', unit: 'ms', color: '#67c9a5', dash: '8 3' },
  { key: 'maxMs', label: 'Maximum duration', unit: 'ms', color: '#d9ac68', dash: '2 3' },
] as const;

export function httpDiagnosticsChart(minutes: InstanceDiagnostics['minutes']) {
  return normalizedDiagnosticsChart(minutes, metrics, 60000);
}
