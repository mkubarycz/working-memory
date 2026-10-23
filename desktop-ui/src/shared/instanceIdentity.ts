export interface InstanceConnectionState {
  environment: string;
  passwordConfigured: boolean;
  passwordHint: string;
  setupAvailable: boolean;
  authenticated: boolean;
}

export interface InstanceAccessSnapshot {
  requests: Array<{
    id: string; label: string; clientId: string | null; access: 'read' | 'write'; source: string;
    state: 'pending' | 'approved'; createdAt: number; expiresAt: number;
  }>;
  clients: Array<{
    id: string; label: string; access: 'read' | 'write'; createdAt: number;
    expiresAt: number; revokedAt: number | null;
  }>;
}

export interface InstanceIdentityApi {
  getInstanceIdentity(): Promise<InstanceConnectionState>;
  signInInstance(input: { password: string; setup: boolean; passwordHint?: string }): Promise<void>;
  signOutInstance(): Promise<void>;
  getInstanceAccess(): Promise<InstanceAccessSnapshot>;
  reviewInstanceAccess(input: { id: string; action: 'approve' | 'deny' | 'revoke' }): Promise<InstanceAccessSnapshot>;
  onInstanceAuthenticationChanged(listener: (event: { mcpUrl: string; authenticated: boolean }) => void): () => void;
}
