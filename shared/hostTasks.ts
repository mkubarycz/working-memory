/** Protected host broker contract. Credentials are returned only at provisioning. */
export const HOST_TASK_CREDENTIAL_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;
export function isHostTaskCredential(value: unknown): value is string {
  return typeof value === 'string' && HOST_TASK_CREDENTIAL_PATTERN.exec(value)?.[0] === value;
}
export const HOST_TASK_CAPABILITY = 'thrive.sync.read' as const;
export const HOST_TASK_OPERATION_VERSION = 4 as const;
/** Reviewed descriptor digest only: NOT an executable-byte hash or code-verification attestation. */
export const HOST_TASK_POLICY_HASH = '55647153d96cfebbd301392a91d9cbb47635ab981dae25dfed26221737d33352';
/** Compatibility name for HOST_TASK_POLICY_HASH; does not verify implementation bytes. */
export const HOST_TASK_OPERATION_HASH = HOST_TASK_POLICY_HASH;
export const HOST_TASK_SCOPE = {
  organization: 'CXPPMO',
  project: 'Customers',
  identity: 'mkubarycz@microsoft.com',
  areaPath: 'Customers\\Comcast',
} as const;
export interface HostTaskApp {
  id: string;
  label: string;
  instanceId: string;
  createdAt: number;
  revokedAt: number | null;
}
export interface HostTaskOperation {
  capability: 'thrive.sync.read';
  version: number;
  scope: typeof HOST_TASK_SCOPE;
  actions: readonly string[];
  fields: readonly string[];
  resultSchemaVersion: 1;
  outputFields: readonly string[];
  query: string;
  budgets: {
    records: number; chunks: number; recordsPerChunk: number; bytes: number; durationMs: number;
    attempts: number; queryCalls: number; detailCalls: number; typeCalls: number;
  };
}
export interface HostTaskGrant {
  id: string;
  appId: string;
  windowsSid: string;
  tenantId: string;
  expiresAt: number;
  generation: number;
  revokedAt: number | null;
  policyHash: string;
  operationHash: string;
  operation: HostTaskOperation;
}
export const HOST_TASK_STATES = [
  'awaiting-approval', 'queued', 'running', 'succeeded', 'failed', 'needs-sign-in',
  'cancelled', 'denied', 'expired', 'acknowledged',
] as const;
export type HostTaskState = typeof HOST_TASK_STATES[number];
export interface HostTaskJob {
  id: string;
  appId: string;
  grantId: string | null;
  state: HostTaskState;
  createdAt: number;
  expiresAt: number;
  attempt: number;
  blockedReason: string | null;
}
export interface HostTaskRunner {
  id: string;
  windowsSid: string;
  tenantId: string;
  createdAt: number;
  revokedAt: number | null;
}
/** Reviewed read-only policy disclosure, not implementation verification evidence. */
export interface HostTaskPolicy {
  policyHash: string;
  /** Compatibility alias for policyHash. */
  operationHash: string;
  operationVersion: number;
  scope: typeof HOST_TASK_SCOPE;
  outputFields: readonly string[];
  actions: readonly string[];
  budgets: HostTaskOperation['budgets'];
  /** Complete descriptor, including query/fields, for canonical policy-hash checks. */
  operation: HostTaskOperation;
}
/** UTF-8 SHA-256 of this JSON identifies policy only, never implementation bytes. */
export function canonicalHostTaskPolicyJson(operation: HostTaskOperation): string {
  return JSON.stringify(operation, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
      : value);
}
export interface HostTaskAdminSnapshot {
  policy: HostTaskPolicy;
  /** Compatibility disclosure alias; identical to policy.operation. */
  operation: HostTaskOperation;
  /** Compatibility descriptor-hash alias; NOT implementation-byte verification. */
  operationHash: string;
  apps: HostTaskApp[];
  grants: HostTaskGrant[];
  jobs: HostTaskJob[];
  runners: HostTaskRunner[];
  executionBlockedReason: string | null;
}
export interface HostTaskRequest {
  capability: typeof HOST_TASK_CAPABILITY;
  idempotencyKey: string;
  manualRefresh?: boolean;
  mode?: 'full' | 'incremental';
  /** Canonical UTC checkpoint; required for incremental mode. */
  checkpoint?: string;
  /** Bounded cache hints only; never authorize direct host gets. */
  knownIds?: number[];
}
export interface HostTaskAppProvisionInput {
  label: string;
  instanceId: string;
}
export interface HostTaskAppProvisionResult {
  appId: string;
  credential: string;
}
interface HostTaskGrantApprovalFields {
  appId: string;
  windowsSid: string;
  tenantId: string;
  /** Epoch milliseconds, future and at most 24 hours from approval. */
  expiresAt: number;
  operationVersion: number;
}
/** Native policy-confirmation binding; operationHash is a compatibility alias. */
export type HostTaskGrantApprovalInput = HostTaskGrantApprovalFields & (
  { policyHash: string; operationHash?: string } |
  { policyHash?: string; operationHash: string }
);
export interface HostTaskRecord {
  id: number;
  title: string;
  state: string;
  type: string;
  revision: number;
  classification: 'OPEN' | 'CLOSED' | 'UNCLASSIFIED';
  assignedTo: string | null;
  createdBy: string | null;
  areaPath: string;
  changedAt: string;
  url: string;
}
export interface HostTaskResultChunk {
  index: number;
  records: HostTaskRecord[];
  sha256: string;
}
export interface HostTaskStateMetadata {
  type: string;
  state: string;
  category: string;
}
/** Metadata row order is insignificant; object keys and rows are canonicalized. */
export function canonicalHostTaskStateMetadataJson(metadata: readonly HostTaskStateMetadata[]): string {
  return JSON.stringify([...metadata].sort((a, b) =>
    a.type < b.type ? -1 : a.type > b.type ? 1 : a.state < b.state ? -1 : a.state > b.state ? 1 : 0)
    .map(row => ({ category: row.category, state: row.state, type: row.type })));
}
/**
 * Chunk sha256 is the lowercase SHA-256 hex digest of this UTF-8 string.
 * Input must already satisfy HostTaskRecord validation. Project the known
 * normalized fields in lexicographic key order; preserve record array order.
 * No whitespace, omitted fields, Unicode normalization, or raw upstream fields.
 */
export function canonicalHostTaskChunkJson(records: readonly HostTaskRecord[]): string {
  return JSON.stringify(records.map(record => ({
    areaPath: record.areaPath,
    assignedTo: record.assignedTo,
    changedAt: record.changedAt,
    classification: record.classification,
    createdBy: record.createdBy,
    id: record.id,
    revision: record.revision,
    state: record.state,
    title: record.title,
    type: record.type,
    url: record.url,
  })));
}
export interface HostTaskResult {
  schemaVersion: 1;
  jobId: string;
  appId: string;
  grantId: string;
  grantGeneration: number;
  attempt: number;
  operationHash: string;
  policyHash: string;
  requestHash: string;
  mode: 'full' | 'incremental';
  asOf: string;
  membershipIds: number[];
  removedIds: number[];
  dataComplete: true;
  /**
   * Conservative: true only with detail coverage and known classification for
   * every current member. Partial/empty deltas with retained members are false.
   * The adapter reclassifies ALL merged records and derives final completeness.
   */
  classificationComplete: boolean;
  stateMetadata: HostTaskStateMetadata[];
  stateMetadataHash: string;
  /** Normalized metadata schema version, not an upstream metadata revision. */
  stateMetadataVersion: 1;
  chunks: HostTaskResultChunk[];
  /** Historical detail delta size, NOT full-snapshot tracked/open/closed counts. */
  recordCount: number;
}
export interface HostTaskLeaseProof {
  jobId: string;
  attempt: number;
  leaseToken: string;
}
/** SHA-256 uses recursively key-sorted JSON objects; array order is significant. */
export interface HostTaskResultSubmission extends HostTaskResult, HostTaskLeaseProof {}
