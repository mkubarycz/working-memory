import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NativeCredentialStorage } from './credentialVault';
import {
  HOST_TASK_SCOPE as ADO_SCOPE,
  HOST_TASK_CAPABILITY,
  HOST_TASK_POLICY_HASH,
  HOST_TASK_OPERATION_VERSION,
  HOST_TASK_STATES,
  canonicalHostTaskPolicyJson,
  isHostTaskCredential,
  type HostTaskOperation,
  type HostTaskAppProvisionInput,
  type HostTaskAppProvisionResult,
  type HostTaskGrantApprovalInput,
  type HostTaskPolicy,
} from '../../../shared/hostTasks';
import type {
  HostTaskAdminSnapshot,
  HostTaskGrantInput,
} from '../shared/hostTasks';

export const HOST_TASK_SCOPE = `Read Thrive items created by or assigned to Michael OR under ${ADO_SCOPE.areaPath} `
  + `in ${ADO_SCOPE.organization} / ${ADO_SCOPE.project}; every five minutes; no ADO writes. `
  + `Organization ${ADO_SCOPE.organization}; project ${ADO_SCOPE.project}; area ${ADO_SCOPE.areaPath}; identity ${ADO_SCOPE.identity}. `
  + 'Bounded manual runs only. Runs trusted, constrained host code, not a sandbox. '
  + 'Windows permissions, organizational policy and Microsoft sign-in still apply.';
export const WINDOWS_HOST_TASK_ADMIN_IMPORT_BLOCKED =
  'Broker admin token import is blocked: a reviewed Windows private-file ACL verifier is required before provisioning new host-task secrets. Existing OS-encrypted credentials can still be read.';
const UNSAFE_APPROVAL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export function hostTaskOrigin(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
    throw new Error('Host tasks require a credential-free loopback /mcp environment URL.');
  }
  return url.origin;
}

export function hostTaskId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new Error('Invalid host-task identifier.');
  }
  return value;
}

export function validateHostTaskApp(input: HostTaskAppProvisionInput): HostTaskAppProvisionInput {
  return checkedAppLabels(input, 100, 128);
}

export function validateHostTaskAppMetadata(input: HostTaskAppProvisionInput): HostTaskAppProvisionInput {
  return checkedAppLabels(input, 200, 200);
}

function checkedAppLabels(input: HostTaskAppProvisionInput, labelLimit: number, instanceLimit: number): HostTaskAppProvisionInput {
  if (!input || typeof input.label !== 'string' || !input.label.trim() || input.label.length > labelLimit
    || typeof input.instanceId !== 'string' || !input.instanceId.trim() || input.instanceId.length > instanceLimit
    || UNSAFE_APPROVAL_CHARACTERS.test(input.label + input.instanceId)) {
    throw new Error(`Provide a label (up to ${labelLimit} characters) and instance ID (up to ${instanceLimit} characters), without control characters.`);
  }
  return { label: input.label.trim(), instanceId: input.instanceId.trim() };
}

export function validateGrant(input: HostTaskGrantInput, now = Date.now()): HostTaskGrantInput {
  if (!input || typeof input !== 'object') throw new Error('Invalid grant.');
  hostTaskId(input.appId);
  if (typeof input.windowsSid !== 'string' || !/^S-1-5-(?:\d+-){1,14}\d+$/.test(input.windowsSid)) {
    throw new Error('Enter a Windows SID, not a display name.');
  }
  if (typeof input.tenantId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.tenantId)) {
    throw new Error('Enter a Microsoft tenant UUID.');
  }
  const expiry = input.expiresAt;
  if (!Number.isSafeInteger(expiry) || expiry <= now || expiry > now + 24 * 60 * 60 * 1000) {
    throw new Error('Grant expiry must be in the future and within 24 hours.');
  }
  return {
    appId: input.appId,
    windowsSid: input.windowsSid,
    tenantId: input.tenantId,
    expiresAt: expiry,
  };
}

export class HostTaskCredentialVault {
  constructor(
    private readonly native: NativeCredentialStorage & { getSelectedStorageBackend?(): string },
    private readonly platform: NodeJS.Platform,
    private readonly directory: string,
  ) {}

  private requireSecureStorage(): void {
    if (!this.native.isEncryptionAvailable()
      || (this.platform === 'linux'
        && (!this.native.getSelectedStorageBackend
          || !['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.native.getSelectedStorageBackend())))) {
      throw new Error('Host-task secrets require OS-backed safeStorage encryption; basic_text is forbidden.');
    }
  }

  private file(origin: string): string {
    return join(this.directory, `${createHash('sha256').update(origin).digest('hex')}.bin`);
  }

  async read(origin: string): Promise<string | null> {
    this.requireSecureStorage();
    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.file(origin));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('Cannot read encrypted host-task credential.');
    }
    try {
      return validSecret(this.native.decryptString(encrypted));
    } catch {
      throw new Error('Cannot decrypt host-task credential. Provision it again using the native file picker.');
    }
  }

  async import(origin: string, source: string): Promise<void> {
    if (this.platform === 'win32') throw new Error(WINDOWS_HOST_TASK_ADMIN_IMPORT_BLOCKED);
    this.requireSecureStorage();
    const file = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    let secret: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096 || stat.size < 1
        || (stat.mode & 0o077) !== 0 || (stat.mode & 0o400) === 0 || stat.uid !== process.getuid?.()) {
        throw new Error('Choose a private, user-owned admin token file (mode 0600), at most 4096 bytes.');
      }
      secret = validSecret((await file.readFile('utf8')).trim());
    } finally {
      await file.close();
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = await open(this.file(origin), constants.O_WRONLY | constants.O_CREAT
      | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      await target.chmod(0o600);
      await target.writeFile(this.native.encryptString(secret));
    } finally {
      await target.close();
    }
  }
}

function validSecret(value: unknown): string {
  if (!isHostTaskCredential(value)) {
    throw new Error('Invalid host-task credential.');
  }
  return value;
}

type Fetch = typeof globalThis.fetch;

export class HostTaskAdminClient {
  readonly origin: string;
  constructor(mcpUrl: string, private readonly credential: string, private readonly fetcher: Fetch = fetch) {
    this.origin = hostTaskOrigin(mcpUrl);
    validSecret(credential);
  }

  protected async request(path: string, body?: object): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}/host-tasks/v1/admin${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: ['Bearer', this.credential].join(' '), 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error('Host-task broker unavailable. Check the selected environment and broker configuration.');
    }
    // Never propagate backend response bodies or transport errors containing secrets to IPC.
    if (!response.ok) throw new Error(`Host-task broker request rejected (HTTP ${response.status}).`);
    try {
      return await response.json();
    } catch {
      throw new Error('Host-task broker returned an invalid response.');
    }
  }

  async snapshot(): Promise<HostTaskAdminSnapshot> {
    const value = await this.request('') as HostTaskAdminSnapshot;
    if (!value || !['apps', 'grants', 'jobs', 'runners'].every((key) =>
      Array.isArray((value as unknown as Record<string, unknown>)[key]))) {
      throw new Error('Host-task broker returned an invalid snapshot.');
    }
    const policy = projectHostTaskPolicy(value.policy);
    if ((value.operationHash !== undefined && value.operationHash !== policy.policyHash)
      || (value.operation !== undefined
        && descriptorHash(projectHostTaskOperation(value.operation)) !== descriptorHash(policy.operation))) {
      throw new Error('Broker returned inconsistent policy compatibility aliases.');
    }
    // Explicit projection keeps credentials and unrecognized backend fields out of the renderer.
    return {
      apps: value.apps.map((item) => ({
        id: hostTaskId(item.id), ...validateHostTaskAppMetadata(item),
        createdAt: timestamp(item.createdAt), revokedAt: item.revokedAt == null ? null : timestamp(item.revokedAt),
      })),
      grants: value.grants.map((item) => ({
        id: text(item.id), appId: text(item.appId), windowsSid: text(item.windowsSid),
        tenantId: text(item.tenantId), expiresAt: timestamp(item.expiresAt),
        generation: timestamp(item.generation), revokedAt: item.revokedAt == null ? null : timestamp(item.revokedAt),
        policyHash: text(item.policyHash),
        operationHash: text(item.operationHash),
        operation: projectHostTaskOperation(item.operation),
      })),
      jobs: value.jobs.map((item) => ({
        id: text(item.id), appId: text(item.appId), grantId: nullableText(item.grantId),
        state: jobState(item.state), createdAt: timestamp(item.createdAt), expiresAt: timestamp(item.expiresAt),
        attempt: timestamp(item.attempt), blockedReason: nullableText(item.blockedReason),
      })),
      runners: value.runners.map((item) => ({
        id: text(item.id), windowsSid: text(item.windowsSid), tenantId: text(item.tenantId),
        createdAt: timestamp(item.createdAt), revokedAt: item.revokedAt == null ? null : timestamp(item.revokedAt),
      })),
      executionBlockedReason: nullableText(value.executionBlockedReason),
      policy, operation: policy.operation, operationHash: policy.policyHash,
    };
  }

  async createApp(input: HostTaskAppProvisionInput): Promise<HostTaskAppProvisionResult> {
    const result = await this.request('/apps', validateHostTaskApp(input)) as HostTaskAppProvisionResult;
    return { appId: hostTaskId(result.appId), credential: validSecret(result.credential) };
  }

  async grant(input: HostTaskGrantInput, policy: HostTaskPolicy): Promise<void> {
    const disclosure = projectHostTaskPolicy(policy);
    reviewedHostTaskOperation(disclosure.operation, disclosure.policyHash);
    const approval: HostTaskGrantApprovalInput = {
      ...validateGrant(input), policyHash: HOST_TASK_POLICY_HASH, operationVersion: HOST_TASK_OPERATION_VERSION,
    };
    await this.request('/grants', approval);
  }

  async revoke(id: string): Promise<void> {
    await this.request(`/grants/${hostTaskId(id)}/revoke`, {});
  }

  async revokeApp(id: string): Promise<void> {
    await this.request(`/apps/${hostTaskId(id)}/revoke`, {});
  }

  async deny(id: string): Promise<void> {
    await this.request(`/jobs/${hostTaskId(id)}/deny`, {});
  }
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid host-task broker metadata.');
  return value;
}

function nullableText(value: unknown): string | null {
  return value == null ? null : text(value);
}

/** Verifies a policy descriptor, not executable bytes, publisher, or effective user identity. */
export function reviewedHostTaskOperation(value: unknown, policyHash: unknown): HostTaskOperation {
  const invalid = () => new Error('Broker policy descriptor does not match this desktop’s reviewed operation descriptor. Upgrade or review the broker; approval is blocked.');
  const operation = projectHostTaskOperation(value);
  if (policyHash !== HOST_TASK_POLICY_HASH || operation.version !== HOST_TASK_OPERATION_VERSION) throw invalid();
  if (descriptorHash(value) !== HOST_TASK_POLICY_HASH || descriptorHash(operation) !== HOST_TASK_POLICY_HASH) throw invalid();
  return operation;
}

function projectHostTaskOperation(value: unknown): HostTaskOperation {
  const invalid = () => new Error('Broker policy descriptor does not match this desktop’s reviewed operation descriptor. Upgrade or review the broker; approval is blocked.');
  if (!value || typeof value !== 'object') throw invalid();
  const raw = value as HostTaskOperation;
  if (raw.capability !== HOST_TASK_CAPABILITY || !Number.isSafeInteger(raw.version) || raw.version < 1
    || !raw.scope || Object.entries(ADO_SCOPE).some(([key, expected]) =>
      raw.scope[key as keyof typeof ADO_SCOPE] !== expected)
    || !Array.isArray(raw.actions) || !raw.actions.length || raw.actions.length > 16
    || !Array.isArray(raw.fields) || !raw.fields.length || raw.fields.length > 32
    || raw.resultSchemaVersion !== 1 || !Array.isArray(raw.outputFields)
    || !raw.outputFields.length || raw.outputFields.length > 64
    || !raw.budgets) throw invalid();
  const operation: HostTaskOperation = {
    capability: HOST_TASK_CAPABILITY, version: raw.version, scope: { ...ADO_SCOPE },
    actions: raw.actions.map(text), fields: raw.fields.map(text), query: text(raw.query),
    resultSchemaVersion: 1, outputFields: raw.outputFields.map(text),
    budgets: {
      records: timestamp(raw.budgets.records), chunks: timestamp(raw.budgets.chunks),
      recordsPerChunk: timestamp(raw.budgets.recordsPerChunk), bytes: timestamp(raw.budgets.bytes),
      durationMs: timestamp(raw.budgets.durationMs), attempts: timestamp(raw.budgets.attempts),
      queryCalls: timestamp(raw.budgets.queryCalls), detailCalls: timestamp(raw.budgets.detailCalls),
      typeCalls: timestamp(raw.budgets.typeCalls),
    },
  };
  if (descriptorHash(value) !== descriptorHash(operation)) throw invalid();
  return operation;
}

function descriptorHash(candidate: unknown): string {
  return createHash('sha256').update(canonicalHostTaskPolicyJson(candidate as HostTaskOperation)).digest('hex');
}

function projectHostTaskPolicy(value: unknown): HostTaskPolicy {
  const invalid = () => new Error('Broker returned an inconsistent policy descriptor disclosure.');
  if (!value || typeof value !== 'object') throw invalid();
  const raw = value as HostTaskPolicy;
  const operation = projectHostTaskOperation(raw.operation);
  if (raw.policyHash !== raw.operationHash || raw.operationVersion !== operation.version
    || !raw.scope || Object.keys(raw.scope).length !== Object.keys(operation.scope).length
    || Object.entries(operation.scope).some(([key, expected]) => raw.scope[key as keyof typeof ADO_SCOPE] !== expected)
    || JSON.stringify(raw.outputFields) !== JSON.stringify(operation.outputFields)
    || JSON.stringify(raw.actions) !== JSON.stringify(operation.actions)
    || !raw.budgets || Object.keys(raw.budgets).length !== Object.keys(operation.budgets).length
    || Object.entries(operation.budgets).some(([key, expected]) =>
      raw.budgets[key as keyof HostTaskOperation['budgets']] !== expected)) throw invalid();
  return {
    policyHash: text(raw.policyHash), operationHash: text(raw.operationHash), operationVersion: operation.version,
    scope: { ...operation.scope }, outputFields: [...operation.outputFields], actions: [...operation.actions],
    budgets: { ...operation.budgets }, operation,
  };
}

export function hostTaskOperationSummary(operation: HostTaskOperation, policyHash: string): string {
  return [
    `Operation: ${operation.capability}; version ${operation.version}`,
    `policyHash (reviewed descriptor SHA-256; NOT executable-byte verification): ${policyHash}`,
    `Scope: created by or assigned to Michael (${operation.scope.identity}) OR under ${operation.scope.areaPath}; `
      + `organization ${operation.scope.organization}; project ${operation.scope.project}.`,
    `Read query (membership rule): ${operation.query}`,
    `Allowed actions: ${operation.actions.join(', ')} (read-only; no ADO writes)`,
    `ADO read fields: ${operation.fields.join(', ')}`,
    `Result schema version: ${operation.resultSchemaVersion}; output fields: ${operation.outputFields.join(', ')}`,
    `Budgets (per run): ${Object.entries(operation.budgets).map(([key, value]) => `${key}=${value}`).join(', ')}.`,
    'Schedule: every five minutes; manual refresh remains bounded and rate-limited.',
    'Tracked item count is scoped membership, not the count of all open task tickets.',
    'Actual executable bytes/publisher and current-user effective identity remain unverified. Execution stays disabled.',
  ].join('\n');
}

function timestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid host-task timestamp or counter.');
  }
  return value;
}

function jobState(value: unknown): HostTaskAdminSnapshot['jobs'][number]['state'] {
  if (typeof value !== 'string' || !(HOST_TASK_STATES as readonly string[]).includes(value)) {
    throw new Error('Invalid host-task job state.');
  }
  return value as HostTaskAdminSnapshot['jobs'][number]['state'];
}
export class WindowsHostTaskRunner {
  constructor(private readonly platform: NodeJS.Platform) {}

  inspect(): {
    state: 'unavailable' | 'blocked';
    platformSupported: boolean;
    checks: Record<'windowsSid' | 'agencyExecutable' | 'publisherAndHash' | 'microsoftIdentity' | 'privateFileAcl', 'unverified'>;
  } {
    return {
      state: this.platform === 'win32' ? 'blocked' : 'unavailable',
      platformSupported: this.platform === 'win32',
      checks: {
        windowsSid: 'unverified', agencyExecutable: 'unverified', publisherAndHash: 'unverified',
        microsoftIdentity: 'unverified', privateFileAcl: 'unverified',
      },
    };
  }

  blockedReason(): string {
    if (!this.inspect().platformSupported) return 'Unavailable: host execution requires Windows.';
    return 'Blocked: current-user effective Windows SID, Agency executable availability, immutable implementation bytes/publisher/hash, and Microsoft tenant/account '
      + 'sign-in evidence have not been independently verified. Windows secret-file ACLs are also unverified. '
      + 'Install and verify the trusted runner and identity integration before enabling execution.';
  }

  async start(): Promise<never> {
    throw new Error(this.blockedReason());
  }
}
