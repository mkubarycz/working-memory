import type { EmbeddingDashboard as Dashboard, EmbeddingHostSettings } from '../../../control-plane/src/embeddingContract';
export type EmbeddingDashboard = Dashboard & EmbeddingHostSettings;
export type EmbeddingAction = 'enable' | 'pause' | 'resume' | 'retry' | 'disable';
