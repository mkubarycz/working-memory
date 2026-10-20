import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_TASK_OPERATION } from '../../control-plane/src/hostTasks';
import { HOST_TASK_OPERATION_HASH, HOST_TASK_OPERATION_VERSION } from '../../shared/hostTasks';
import { hostTaskPolicy } from './fixtures/hostTaskPolicy';
import {
  HostTaskAdminClient,
  HostTaskCredentialVault,
  WindowsHostTaskRunner,
  hostTaskOrigin,
  validateGrant,
  validateHostTaskApp,
  reviewedHostTaskOperation,
  hostTaskOperationSummary,
} from '../src/main/hostTaskBroker';

const directories: string[] = [];
const credential = 'test-only-not-a-real-secret-value';
const mcpUrl = 'http://127.0.0.1:3000/mcp';
const now = Date.parse('2026-10-20T12:00:00Z');
const grant = {
  appId: 'app-test', windowsSid: 'S-1-5-21-100-200-300-1001',
  tenantId: '11111111-2222-3333-4444-555555555555', expiresAt: now + 3_600_000,
};

function native(backend = 'gnome_libsecret') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: vi.fn((value: string) => Buffer.from(`encrypted:${value}`)),
    decryptString: vi.fn((value: Buffer) => value.toString().slice('encrypted:'.length)),
  };
}

function directory() {
  const value = mkdtempSync(join(tmpdir(), 'host-task-test-'));
  directories.push(value);
  return value;
}

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('trusted host-task transport', () => {
  it.each(['short', 'a'.repeat(31), 'a'.repeat(257), 'a'.repeat(32) + '\r\n',
    ...['\n', '\r', '\u2028', '\u2029'].map((suffix) => 'a'.repeat(32) + suffix)])(
    'rejects invalid broker credentials before transport',
    (invalid) => {
      const fetcher = vi.fn();
      expect(() => new HostTaskAdminClient(mcpUrl, invalid, fetcher)).toThrow('credential');
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    'https://127.0.0.1:3000/mcp', 'http://example.com/mcp',
    'http://127.0.0.1.evil.test/mcp',
    'http://127.0.0.1/mcp?token=secret', 'http://127.0.0.1/mcp#secret',
    'http://127.0.0.1/other',
  ])('rejects unsafe environment URL %s', (url) => {
    expect(() => hostTaskOrigin(url)).toThrow();
  });

  it('rejects embedded URL credentials', () => {
    const url = new URL(mcpUrl);
    url.username = 'user';
    url.password = 'example-password';
    expect(() => hostTaskOrigin(url.href)).toThrow('credential-free');
  });

  it('supports loopback IPv6 and uses auth only in headers, with redirect rejection', async () => {
    expect(hostTaskOrigin('http://[::1]:3000/mcp')).toBe('http://[::1]:3000');
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      apps: [], grants: [], jobs: [], runners: [], executionBlockedReason: 'disabled',
      policy: hostTaskPolicy,
      credential,
    })));
    const client = new HostTaskAdminClient(mcpUrl, credential, fetcher);
    expect(await client.snapshot()).not.toHaveProperty('credential');
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:3000/host-tasks/v1/admin');
    expect(url).not.toContain(credential);
    expect(options.redirect).toBe('error');
    expect(options.headers.Authorization).toBe(['Bearer', credential].join(' '));
    expect(options.body).toBeUndefined();
  });

  it('projects allowlisted fields and never returns app credentials in snapshots', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      apps: [{ id: 'app', label: 'App', instanceId: 'instance', createdAt: now, credential }],
      grants: [{ ...grant, id: 'grant', generation: 1, revokedAt: null, credential,
        operation: HOST_TASK_OPERATION, operationHash: HOST_TASK_OPERATION_HASH, policyHash: HOST_TASK_OPERATION_HASH }],
      jobs: [{ id: 'job', appId: 'app', grantId: 'grant', state: 'queued',
        createdAt: now, expiresAt: now + 60_000, attempt: 0, blockedReason: null, credential }],
      runners: [{ id: 'runner', windowsSid: grant.windowsSid, tenantId: grant.tenantId, createdAt: now, credential }],
      executionBlockedReason: null,
      policy: hostTaskPolicy,
    })));
    expect(JSON.stringify(await new HostTaskAdminClient(mcpUrl, credential, fetcher).snapshot())).not.toContain(credential);
  });

  it.each(['awaiting-approval', 'failed', 'needs-sign-in'])('supports %s jobs without an approved grant', async (state) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      apps: [], grants: [], runners: [], executionBlockedReason: 'unavailable',
      policy: hostTaskPolicy,
      jobs: [{ id: 'job', appId: 'app', grantId: null, state,
        createdAt: now, expiresAt: now + 60_000, attempt: 0, blockedReason: 'not verified' }],
    })));
    const snapshot = await new HostTaskAdminClient(mcpUrl, credential, fetcher).snapshot();
    expect(snapshot.jobs[0]).toMatchObject({ state, grantId: null });
  });

  it.each(['label', 'instanceId'])('rejects display-spoofing %s metadata from the broker', async (field) => {
    const app = { id: 'app', label: 'App', instanceId: 'instance', createdAt: now, revokedAt: null, [field]: 'spoof\u202e' };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      apps: [app], grants: [], jobs: [], runners: [], executionBlockedReason: 'disabled', policy: hostTaskPolicy,
    })));
    await expect(new HostTaskAdminClient(mcpUrl, credential, fetcher).snapshot()).rejects.toThrow('control characters');
  });

  it('accepts safe broker metadata up to its existing 200-character bound', async () => {
    const app = { id: 'app', label: 'A'.repeat(200), instanceId: 'i'.repeat(200), createdAt: now, revokedAt: null };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      apps: [app], grants: [], jobs: [], runners: [], executionBlockedReason: 'disabled', policy: hostTaskPolicy,
    })));
    expect((await new HostTaskAdminClient(mcpUrl, credential, fetcher).snapshot()).apps[0]).toEqual(app);
  });

  it('rejects a policy compatibility alias that contradicts the primary descriptor', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      apps: [], grants: [], jobs: [], runners: [], executionBlockedReason: 'disabled',
      policy: hostTaskPolicy, operationHash: 'inconsistent',
    })));
    await expect(new HostTaskAdminClient(mcpUrl, credential, fetcher).snapshot()).rejects.toThrow('compatibility aliases');
  });

  it.each([401, 403, 500])('scrubs HTTP %s response bodies', async (status) => {
    const fetcher = vi.fn().mockResolvedValue(new Response(credential, { status }));
    await expect(new HostTaskAdminClient(mcpUrl, credential, fetcher).snapshot())
      .rejects.toThrow(`HTTP ${status}`);
  });

  it('scrubs transport errors and rejects malformed snapshots', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error(credential));
    await expect(new HostTaskAdminClient(mcpUrl, credential, fetcher).snapshot())
      .rejects.toThrow('Host-task broker unavailable.');
    fetcher.mockResolvedValue(new Response('{}'));
    await expect(new HostTaskAdminClient(mcpUrl, credential, fetcher).snapshot())
      .rejects.toThrow('invalid snapshot');
  });

  it('rejects path injection before sending an admin mutation', async () => {
    const fetcher = vi.fn();
    const client = new HostTaskAdminClient(mcpUrl, credential, fetcher);
    await expect(client.revoke('../apps')).rejects.toThrow('identifier');
    await expect(client.revokeApp('../apps')).rejects.toThrow('identifier');
    await expect(client.deny('job?credential=secret')).rejects.toThrow('identifier');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses only the fixed admin POST endpoints for mutations', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{}'));
    const client = new HostTaskAdminClient(mcpUrl, credential, fetcher);
    await client.revoke('grant');
    await client.revokeApp('app');
    await client.deny('job');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:3000/host-tasks/v1/admin/grants/grant/revoke',
      'http://127.0.0.1:3000/host-tasks/v1/admin/apps/app/revoke',
      'http://127.0.0.1:3000/host-tasks/v1/admin/jobs/job/deny',
    ]);
    expect(fetcher.mock.calls.every(([, options]) => options.method === 'POST')).toBe(true);
  });

  it('binds grant approval to the reviewed backend policy digest and version, not renderer claims', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('{}'));
    const client = new HostTaskAdminClient(mcpUrl, credential, fetcher);
    const input = { ...grant, expiresAt: Date.now() + 60_000 };
    await client.grant(input, hostTaskPolicy);
    const payload = JSON.parse(fetcher.mock.calls[0][1].body);
    expect(payload).toEqual({
      ...input, policyHash: HOST_TASK_OPERATION_HASH, operationVersion: HOST_TASK_OPERATION_VERSION,
    });
    expect(payload).not.toHaveProperty('credential');
  });
});

describe('host-task private vault', () => {
  it('uses native encryption, private files, and environment-specific storage', async () => {
    const root = directory();
    const source = join(root, 'admin.secret');
    writeFileSync(source, `${credential}\n`, { mode: 0o600 });
    const storage = native();
    const vault = new HostTaskCredentialVault(storage, 'linux', join(root, 'vault'));
    await vault.import('http://127.0.0.1:3000', source);
    expect(await vault.read('http://127.0.0.1:3000')).toBe(credential);
    expect(await vault.read('http://127.0.0.1:3001')).toBeNull();
    expect(storage.encryptString).toHaveBeenCalledWith(credential);
    expect(statSync(join(root, 'vault')).mode & 0o777).toBe(0o700);
    expect(readFileSync(source, 'utf8')).toBe(`${credential}\n`);
  });

  it.each(['basic_text', 'unknown'])('rejects unsafe Linux backend %s', async (backend) => {
    const storage = native(backend);
    const vault = new HostTaskCredentialVault(storage, 'linux', directory());
    await expect(vault.read('http://127.0.0.1:3000')).rejects.toThrow('safeStorage');
    await expect(vault.import('http://127.0.0.1:3000', 'unused')).rejects.toThrow('safeStorage');
    expect(storage.encryptString).not.toHaveBeenCalled();
  });

  it('rejects unavailable native encryption rather than falling back to a local key', async () => {
    const storage = { ...native(), isEncryptionAvailable: () => false };
    const vault = new HostTaskCredentialVault(storage, 'darwin', directory());
    await expect(vault.read('http://127.0.0.1:3000')).rejects.toThrow('safeStorage');
  });

  it('blocks Windows source-token imports before reading any file or encrypting without verified ACLs', async () => {
    const storage = native();
    const vault = new HostTaskCredentialVault(storage, 'win32', directory());
    await expect(vault.import('http://127.0.0.1:3000', 'must-not-open'))
      .rejects.toThrow('Windows private-file ACL verifier');
    expect(storage.encryptString).not.toHaveBeenCalled();
  });

  it('allows reading an existing OS-encrypted credential on Windows without enabling new source imports', async () => {
    const root = directory();
    const source = join(root, 'admin.secret');
    writeFileSync(source, credential, { mode: 0o600 });
    const storage = native();
    const path = join(root, 'vault');
    await new HostTaskCredentialVault(storage, 'linux', path).import('http://127.0.0.1:3000', source);
    const windowsVault = new HostTaskCredentialVault(storage, 'win32', path);
    expect(await windowsVault.read('http://127.0.0.1:3000')).toBe(credential);
    await expect(windowsVault.import('http://127.0.0.1:3000', source)).rejects.toThrow('ACL verifier');
  });

  it('rejects a world-readable source token', async () => {
    const root = directory();
    const source = join(root, 'admin.secret');
    writeFileSync(source, credential, { mode: 0o644 });
    const vault = new HostTaskCredentialVault(native(), 'linux', join(root, 'vault'));
    await expect(vault.import('http://127.0.0.1:3000', source)).rejects.toThrow('private');
  });

  it('rejects a source token without owner-read permission, even when the process could bypass permissions', async () => {
    const root = directory();
    const source = join(root, 'admin.secret');
    writeFileSync(source, credential, { mode: 0o200 });
    const storage = native();
    const vault = new HostTaskCredentialVault(storage, 'linux', join(root, 'vault'));
    await expect(vault.import('http://127.0.0.1:3000', source)).rejects.toThrow();
    expect(storage.encryptString).not.toHaveBeenCalled();
  });

  it('rejects symlink token files instead of following them', async () => {
    const root = directory();
    const source = join(root, 'admin.secret');
    const link = join(root, 'admin.link');
    writeFileSync(source, credential, { mode: 0o600 });
    symlinkSync(source, link);
    const vault = new HostTaskCredentialVault(native(), 'linux', join(root, 'vault'));
    await expect(vault.import('http://127.0.0.1:3000', link)).rejects.toThrow();
  });
});

describe('host-task grant and runner gates', () => {
  it('verifies the actual backend policy against the reviewed digest and displays the complete approval scope', () => {
    const policy = reviewedHostTaskOperation(HOST_TASK_OPERATION, HOST_TASK_OPERATION_HASH);
    const description = hostTaskOperationSummary(policy, HOST_TASK_OPERATION_HASH);
    expect(description).toContain(`version ${HOST_TASK_OPERATION_VERSION}`);
    expect(description).toContain(HOST_TASK_OPERATION_HASH);
    expect(description).toContain(policy.query);
    for (const field of policy.fields) expect(description).toContain(field);
    for (const field of policy.outputFields) expect(description).toContain(field);
    for (const action of policy.actions) expect(description).toContain(action);
    for (const value of Object.values(policy.budgets)) expect(description).toContain(String(value));
    expect(description).toContain('five minutes');
    expect(description).toContain('no ADO writes');
    expect(description).toContain('policyHash');
    expect(description).toContain('NOT executable-byte verification');
    expect(description).toContain('current-user effective identity remain unverified');
    expect(description).toContain('OR under Customers\\Comcast');
    expect(description).toContain('not the count of all open task tickets');
  });

  it.each([
    { ...HOST_TASK_OPERATION, version: HOST_TASK_OPERATION_VERSION + 1 },
    { ...HOST_TASK_OPERATION, actions: ['query', 'write'] },
    { ...HOST_TASK_OPERATION, fields: [...HOST_TASK_OPERATION.fields, 'System.Description'] },
    { ...HOST_TASK_OPERATION, outputFields: [...HOST_TASK_OPERATION.outputFields, 'unreviewed'] },
    { ...HOST_TASK_OPERATION, budgets: { ...HOST_TASK_OPERATION.budgets, records: 999999 } },
    { ...HOST_TASK_OPERATION, scope: { ...HOST_TASK_OPERATION.scope, organization: 'Other' } },
    { ...HOST_TASK_OPERATION, unreviewedAction: 'write' },
  ])('rejects an altered operation even if it claims the reviewed hash', (operation) => {
    expect(() => reviewedHostTaskOperation(operation, HOST_TASK_OPERATION_HASH)).toThrow('reviewed operation');
  });

  it('rejects a policy whose advertised digest is not the reviewed digest', () => {
    expect(() => reviewedHostTaskOperation(HOST_TASK_OPERATION, 'unreviewed')).toThrow('reviewed operation');
  });

  it('bounds approval expiry and requires SID/tenant identity declarations', () => {
    expect(validateGrant(grant, now)).toEqual(grant);
    for (const invalid of [
      { ...grant, windowsSid: 'Administrator' }, { ...grant, tenantId: 'common' },
      { ...grant, expiresAt: NaN }, { ...grant, expiresAt: now },
      { ...grant, expiresAt: now + 86_400_001 },
    ]) expect(() => validateGrant(invalid, now)).toThrow();
  });

  it.each(['win32', 'linux', 'darwin'] as const)('never executes host code on %s', async (platform) => {
    const runner = new WindowsHostTaskRunner(platform);
    expect(runner.inspect()).toMatchObject({
      state: platform === 'win32' ? 'blocked' : 'unavailable',
      platformSupported: platform === 'win32',
      checks: {
        windowsSid: 'unverified', agencyExecutable: 'unverified', publisherAndHash: 'unverified',
        microsoftIdentity: 'unverified', privateFileAcl: 'unverified',
      },
    });
    await expect(runner.start()).rejects.toThrow(runner.blockedReason());
  });

  it('rejects native-dialog injection and oversized labels before app provisioning', () => {
    expect(validateHostTaskApp({ label: ' App ', instanceId: ' instance ' })).toEqual({ label: 'App', instanceId: 'instance' });
    for (const input of [
      { label: 'App\nIgnore the warning', instanceId: 'instance' },
      { label: 'x'.repeat(101), instanceId: 'instance' },
      { label: 'App', instanceId: '' },
    ]) expect(() => validateHostTaskApp(input)).toThrow();
  });

  it.each(['\u202e', '\u2066', '\u200b', '\u200d', '\ufeff', '\u2028'])(
    'rejects bidi, zero-width, format and line controls in approval labels and instance identifiers',
    (character) => {
      expect(() => validateHostTaskApp({ label: `App${character}`, instanceId: 'instance' })).toThrow('control characters');
      expect(() => validateHostTaskApp({ label: 'App', instanceId: `instance${character}` })).toThrow('control characters');
    },
  );
});
