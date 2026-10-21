import type { HostTaskAdminSnapshot } from '../../../shared/hostTasks';
import type { HostTaskGrantApprovalInput, HostTaskAppProvisionInput } from '../../../shared/hostTasks';
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
  getHostTasks(): Promise<HostTaskDesktopState>;
  provisionHostTaskAdmin(): Promise<void>;
  exportHostTaskApp(input: HostTaskAppProvisionInput): Promise<void>;
  revokeHostTaskApp(id: string): Promise<void>;
  approveHostTaskGrant(input: HostTaskGrantInput): Promise<void>;
  revokeHostTaskGrant(id: string): Promise<void>;
  denyHostTaskJob(id: string): Promise<void>;
}
