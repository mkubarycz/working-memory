import type { InstancePermissions } from '../../../control-plane/src/instancePermissions';
import type { HeapCollection, SessionPolicy, SessionSnapshot } from '../../../control-plane/src/sessionPolicy';
import type { DesktopDiagnostics, DesktopToolQueue } from '../../../control-plane/src/diagnosticContract';
export type HeapRecoveryResult =
  | { status: 'cancelled' }
  | { status: 'collected'; topicId: string; collection: HeapCollection; snapshot: SessionSnapshot }
  | { status: 'failed'; topicId: string; error: string };
export type { InstancePermissions };
export type InstanceAccessAction =
  | { id: string; action: 'approve' | 'deny' | 'revoke' }
  | { id: string; action: 'permissions'; target: 'request' | 'client'; permissions: InstancePermissions };

export interface InstanceConnectionState {
  environment: string;
  passwordConfigured: boolean;
  passwordHint: string;
  setupAvailable: boolean;
  authenticated: boolean;
  rememberPasswordAvailable?: boolean;
  rememberPasswordShared?: boolean;
  rememberPasswordError?: string;
}

export interface InstanceAccessSnapshot {
  requests: Array<{
    id: string; label: string; clientId: string | null; access: 'read' | 'write'; source: string;
    state: 'pending' | 'approved' | 'denied'; createdAt: number; expiresAt: number; permissions: InstancePermissions;
    purpose?: 'access' | 'permissions';
  }>;
  clients: Array<{
    id: string; label: string; access: 'read' | 'write'; createdAt: number;
    expiresAt: number; revokedAt: number | null; permissions: InstancePermissions;
  }>;
}

export interface InstanceIdentityApi {
  getInstanceIdentity(): Promise<InstanceConnectionState>;
  signInInstance(input: { password: string; setup: boolean; passwordHint?: string; rememberPassword?: boolean }): Promise<void>;
  signOutInstance(): Promise<void>;
  getInstanceAccess(): Promise<InstanceAccessSnapshot>;
  reviewInstanceAccess(input: InstanceAccessAction): Promise<InstanceAccessSnapshot>;
  getSessionDiagnostics(before?: number): Promise<SessionSnapshot>;
  getInstanceDiagnostics(): Promise<DesktopDiagnostics>;
  getToolQueue(): Promise<DesktopToolQueue>;
  inspectQueuedRequest(requestId: string, mcpUrl: string): Promise<{ requestId: string; body: unknown }>;
  recoverInstanceHeap(mcpUrl: string): Promise<HeapRecoveryResult>;
  updateSessionPolicy(policy: SessionPolicy, mcpUrl: string): Promise<SessionSnapshot>;
  onInstanceAuthenticationChanged(listener: (event: { mcpUrl: string; authenticated: boolean }) => void): () => void;
}
