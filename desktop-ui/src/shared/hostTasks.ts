import type { HostTaskAdminSnapshot } from '../../../shared/hostTasks';
import type { HostTaskGrantApprovalInput, HostTaskAppProvisionInput } from '../../../shared/hostTasks';
import type { ScriptSnapshot, ScriptTask, ScriptParameters, ScriptJob } from '../../../control-plane/src/hostScriptPolicy';
export type { ScriptTask, ScriptParameters, ScriptJob } from '../../../control-plane/src/hostScriptPolicy';
export type { HostTaskAdminSnapshot } from '../../../shared/hostTasks';
export { HOST_TASK_SCOPE } from '../../../shared/hostTasks';
export type HostTaskGrantInput = Pick<HostTaskGrantApprovalInput, 'appId' | 'windowsSid' | 'tenantId' | 'expiresAt'>;

export interface HostTaskDesktopState {
  environment: string | null;
  credentialReady: boolean;
  runnerBlockedReason: string;
  appProvisioningBlockedReason: string | null;
  adminProvisioningBlockedReason: string | null;
  snapshot: HostTaskAdminSnapshot | null;
}

export interface HostTaskDesktopApi {
  signInHostScripts(input: { password: string; setup: boolean; passwordHint?: string }): Promise<void>;
  setInstancePasswordHint(hint: string): Promise<void>;
  signOutHostScripts(): Promise<void>;
  getHostScripts(): Promise<HostScriptDesktopState>;
  registerHostScript(input: { name: string; description: string; parameters: unknown; timeoutMs: number; example: boolean }): Promise<ScriptTask | undefined>;
  grantHostScript(input: { taskId: string; appId: string; expiresAt: number }): Promise<void>;
  revokeHostScript(id: string, grant: boolean): Promise<void>;
  testHostScript(id: string, parameters: unknown): Promise<ScriptJob | undefined>;
  getHostScriptJob(id: string): Promise<ScriptJob>;
  processNextHostScript(): Promise<ScriptJob | null>;
  stopHostScript(): Promise<void>;
  getHostTasks(): Promise<HostTaskDesktopState>;
  provisionHostTaskAdmin(): Promise<void>;
  exportHostTaskApp(input: HostTaskAppProvisionInput): Promise<void>;
  revokeHostTaskApp(id: string): Promise<void>;
  approveHostTaskGrant(input: HostTaskGrantInput): Promise<void>;
  revokeHostTaskGrant(id: string): Promise<void>;
  denyHostTaskJob(id: string): Promise<void>;
}

export interface HostScriptDesktopState {
  environment: string; hostId: string; credentialReady: boolean; snapshot: ScriptSnapshot | null;
  authentication?: { passwordConfigured: boolean; passwordHint: string; setupAvailable: boolean };
}
