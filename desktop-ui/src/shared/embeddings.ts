import type { EmbeddingDashboard as Dashboard, EmbeddingHostSettings } from '../../../control-plane/src/embeddingContract';
export type EmbeddingDashboard = Dashboard & EmbeddingHostSettings;
export type EmbeddingAction = 'enable' | 'pause' | 'resume' | 'retry' | 'disable';
export interface EmbeddingDiagnostics {
  logPath: string;
  logExists: boolean;
  log: string;
  service: {
    state: 'running' | 'unreachable' | 'not-installed';
    version: string | null;
    expectedVersion: string;
    phase: string | null;
    backend: string | null;
    error: string | null;
    endpoints?: string[];
  };
}
