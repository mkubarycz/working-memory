import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HOST_TASK_OPERATION } from '../../control-plane/src/hostTasks';
import { HOST_TASK_OPERATION_HASH } from '../../shared/hostTasks';
import { hostTaskPolicy } from './fixtures/hostTaskPolicy';
import { assertHostTaskSender, registerHostTaskIpc } from '../src/main/hostTaskIpc';

const rendererUrl = 'file:///working-memory/renderer/index.html';
const adminCredential = 'test-only-admin-credential-value-0001';
const appCredential = 'test-only-exported-credential-value-0001';
const directories: string[] = [];
function fixture(platform: NodeJS.Platform = 'linux') {
  const frame = { url: rendererUrl };
  const window = { webContents: { mainFrame: frame }, isDestroyed: () => false };
  const event = { sender: window.webContents, senderFrame: frame };
  let environment = { mcpUrl: 'http://127.0.0.1:3000/mcp', displayName: 'Selected' };
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const vault = { read: vi.fn().mockResolvedValue(adminCredential), import: vi.fn() };
  const client = {
    snapshot: vi.fn().mockResolvedValue({
      apps: [{ id: 'app', label: 'Trusted App', instanceId: 'trusted-instance', createdAt: 0, revokedAt: null }],
      jobs: [], grants: [], runners: [], executionBlockedReason: null,
      policy: hostTaskPolicy,
    }),
    createApp: vi.fn().mockResolvedValue({ appId: 'app', credential: appCredential }),
    grant: vi.fn(), revoke: vi.fn(), revokeApp: vi.fn(), deny: vi.fn(),
  };
  const dialog = {
    showMessageBox: vi.fn().mockResolvedValue({ response: 1 }),
    showOpenDialog: vi.fn().mockResolvedValue({ canceled: false, filePaths: ['native-selected-file'] }),
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
  };
  registerHostTaskIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    getWindow: () => window, getEnvironment: () => environment, rendererUrl, vault, platform,
    dialog, createClient: () => client,
  } as unknown as Parameters<typeof registerHostTaskIpc>[0]);
  return {
    event, frame, window, vault, client, dialog,
    changeEnvironment: () => { environment = { ...environment, mcpUrl: 'http://127.0.0.1:3001/mcp' }; },
    call: (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args),
    untrusted: (channel: string, event: unknown) => handlers.get(channel)!(event),
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true });
});

describe('host-task trusted IPC', () => {
  it('allows only the expected main window main frame URL', () => {
    const { event, window, frame } = fixture();
    expect(() => assertHostTaskSender(event, window, rendererUrl)).not.toThrow();
    expect(() => assertHostTaskSender({ ...event, sender: {} }, window, rendererUrl)).toThrow('main frame');
    expect(() => assertHostTaskSender({ ...event, senderFrame: { url: rendererUrl } }, window, rendererUrl))
      .toThrow('main frame');
    expect(() => assertHostTaskSender({ ...event, senderFrame: null }, window, rendererUrl)).toThrow('main frame');
    expect(() => assertHostTaskSender(event, null, rendererUrl)).toThrow('main frame');
    frame.url = 'https://untrusted.example/';
    expect(() => assertHostTaskSender(event, window, rendererUrl)).toThrow('this page');
  });

  it('guards every admin channel before accessing secrets or dialogs', async () => {
    const value = fixture();
    for (const channel of ['get', 'provision-admin', 'export-app', 'approve', 'revoke', 'revoke-app', 'deny']) {
      await expect(value.untrusted(`host-tasks:${channel}`, {
        sender: value.event.sender, senderFrame: { url: rendererUrl },
      })).rejects.toThrow('main frame');
    }
    expect(value.vault.read).not.toHaveBeenCalled();
    expect(value.vault.import).not.toHaveBeenCalled();
    expect(value.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('provisions admin secrets only from the native picker into the environment vault', async () => {
    const value = fixture();
    expect(await value.call('host-tasks:provision-admin')).toBeUndefined();
    expect(value.vault.import).toHaveBeenCalledWith('http://127.0.0.1:3000', 'native-selected-file');
    expect(value.dialog.showMessageBox.mock.calls[0][1].detail).toContain('WM_HOST_TASK_ADMIN_TOKEN_FILE');
  });

  it('does not provision when user cancels native approval', async () => {
    const value = fixture();
    value.dialog.showMessageBox.mockResolvedValue({ response: 0 });
    await value.call('host-tasks:provision-admin');
    expect(value.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(value.vault.import).not.toHaveBeenCalled();
  });

  it('blocks Windows admin imports before showing a native file picker when ACL verification is unavailable', async () => {
    const value = fixture('win32');
    await expect(value.call('host-tasks:provision-admin')).rejects.toThrow('Windows private-file ACL verifier');
    expect(value.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(value.dialog.showOpenDialog).not.toHaveBeenCalled();
    expect(value.vault.import).not.toHaveBeenCalled();
  });

  it('aborts provisioning if environment changes during a native dialog', async () => {
    const value = fixture();
    value.dialog.showOpenDialog.mockImplementation(async () => {
      value.changeEnvironment();
      return { canceled: false, filePaths: ['native-selected-file'] };
    });
    await expect(value.call('host-tasks:provision-admin')).rejects.toThrow('environment changed');
    expect(value.vault.import).not.toHaveBeenCalled();
  });

  it('rejects main-frame navigation during a native approval', async () => {
    const value = fixture();
    value.dialog.showMessageBox.mockImplementation(async () => {
      value.frame.url = 'https://untrusted.example/';
      return { response: 1 };
    });
    await expect(value.call('host-tasks:revoke', 'grant')).rejects.toThrow('this page');
    expect(value.client.revoke).not.toHaveBeenCalled();
  });

  it('requires native scope review and cancel-default buttons for grants', async () => {
    const value = fixture();
    const input = {
      appId: 'app', windowsSid: 'S-1-5-21-1-2-3-1001',
      tenantId: '11111111-2222-3333-4444-555555555555',
      expiresAt: Date.now() + 3_600_000,
    };
    await value.call('host-tasks:approve', input);
    const [, options] = value.dialog.showMessageBox.mock.calls[0];
    expect(options.defaultId).toBe(0);
    expect(options.cancelId).toBe(0);
    for (const scope of ['Read Thrive items created by or assigned to Michael OR under Customers\\Comcast',
      'five minutes', 'no ADO writes', 'not a sandbox', input.windowsSid, input.tenantId,
      new Date(input.expiresAt).toISOString(), 'CXPPMO', 'Customers\\Comcast', 'Trusted App', 'trusted-instance']) {
      expect(options.detail).toContain(scope);
    }
    expect(value.client.grant).toHaveBeenCalledWith(input, hostTaskPolicy);
    expect(options.detail).toContain(HOST_TASK_OPERATION_HASH);
    for (const field of HOST_TASK_OPERATION.outputFields) expect(options.detail).toContain(field);
    for (const budget of Object.keys(HOST_TASK_OPERATION.budgets)) expect(options.detail).toContain(budget);
  });

  it('rejects grant approval for an app not returned by the trusted admin snapshot', async () => {
    const value = fixture();
    await expect(value.call('host-tasks:approve', {
      appId: 'unknown-app', windowsSid: 'S-1-5-21-1-2-3-1001',
      tenantId: '11111111-2222-3333-4444-555555555555', expiresAt: Date.now() + 60_000,
    })).rejects.toThrow('no longer registered');
    expect(value.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(value.client.grant).not.toHaveBeenCalled();
  });

  it('rejects an altered policy before showing approval or mutating a grant', async () => {
    const value = fixture();
    const snapshot = await value.client.snapshot();
    value.client.snapshot.mockResolvedValue({
      ...snapshot, policy: { ...hostTaskPolicy, operation: { ...HOST_TASK_OPERATION, query: 'SELECT unreviewed FROM another scope' } },
    });
    await expect(value.call('host-tasks:approve', {
      appId: 'app', windowsSid: 'S-1-5-21-1-2-3-1001',
      tenantId: '11111111-2222-3333-4444-555555555555', expiresAt: Date.now() + 60_000,
    })).rejects.toThrow('reviewed operation');
    expect(value.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(value.client.grant).not.toHaveBeenCalled();
  });

  it('rejects granting a revoked app credential', async () => {
    const value = fixture();
    const snapshot = await value.client.snapshot();
    value.client.snapshot.mockResolvedValue({
      ...snapshot, apps: [{ ...snapshot.apps[0], revokedAt: Date.now() }],
    });

    await expect(value.call('host-tasks:approve', {
      appId: 'app', windowsSid: 'S-1-5-21-1-2-3-1001',
      tenantId: '11111111-2222-3333-4444-555555555555', expiresAt: Date.now() + 60_000,
    })).rejects.toThrow('credential is revoked');
    expect(value.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(value.client.grant).not.toHaveBeenCalled();
  });

  it.each([
    ['host-tasks:approve', 'label'], ['host-tasks:approve', 'instanceId'],
    ['host-tasks:revoke-app', 'label'], ['host-tasks:revoke-app', 'instanceId'],
  ])('rejects spoofed %s metadata in %s before native confirmation', async (channel, field) => {
    const value = fixture();
    const snapshot = await value.client.snapshot();
    value.client.snapshot.mockResolvedValue({
      ...snapshot, apps: [{ ...snapshot.apps[0], [field]: 'spoof\u202e' }],
    });
    const argument = channel === 'host-tasks:approve'
      ? { appId: 'app', windowsSid: 'S-1-5-21-1-2-3-1001',
        tenantId: '11111111-2222-3333-4444-555555555555', expiresAt: Date.now() + 60_000 }
      : 'app';
    await expect(value.call(channel, argument)).rejects.toThrow('control characters');
    expect(value.dialog.showMessageBox).not.toHaveBeenCalled();
    expect(value.client.grant).not.toHaveBeenCalled();
    expect(value.client.revokeApp).not.toHaveBeenCalled();
  });

  it('never exports app secrets automatically on Windows with unverified ACLs', async () => {
    const value = fixture('win32');
    await expect(value.call('host-tasks:export-app', { label: 'App', instanceId: 'instance' }))
      .rejects.toThrow('ACL verification');
    expect(value.client.createApp).not.toHaveBeenCalled();
    expect(value.dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it('requires native confirmation of the trusted app before revoking its credential', async () => {
    const value = fixture();
    expect(await value.call('host-tasks:revoke-app', 'app')).toBeUndefined();
    const [, options] = value.dialog.showMessageBox.mock.calls[0];
    expect(options.detail).toContain('Trusted App');
    expect(options.detail).toContain('trusted-instance');
    expect(options.detail).toContain('invalidates the app credential');
    expect(options.defaultId).toBe(0);
    expect(value.client.revokeApp).toHaveBeenCalledWith('app');
  });

  it('does not revoke an app credential if native confirmation is canceled', async () => {
    const value = fixture();
    value.dialog.showMessageBox.mockResolvedValue({ response: 0 });
    await value.call('host-tasks:revoke-app', 'app');
    expect(value.client.revokeApp).not.toHaveBeenCalled();
  });

  it('exports app credentials only to the native selected new mode-0600 file, not IPC', async () => {
    const value = fixture();
    const directory = mkdtempSync(join(tmpdir(), 'host-task-ipc-test-'));
    directories.push(directory);
    const path = join(directory, 'app.secret');
    value.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path });
    expect(await value.call('host-tasks:export-app', { label: 'App', instanceId: 'instance' })).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(`${appCredential}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await expect(value.call('host-tasks:export-app', { label: 'App', instanceId: 'instance' })).rejects.toThrow();
    expect(value.client.createApp).toHaveBeenCalledTimes(1);
  });

  it('does not create an app when the native save picker is canceled', async () => {
    const value = fixture();
    await value.call('host-tasks:export-app', { label: 'App', instanceId: 'instance' });
    expect(value.client.createApp).not.toHaveBeenCalled();
  });

  it('cleans up a reserved export file if broker provisioning fails', async () => {
    const value = fixture();
    const directory = mkdtempSync(join(tmpdir(), 'host-task-ipc-test-'));
    directories.push(directory);
    const path = join(directory, 'app.secret');
    value.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: path });
    value.client.createApp.mockRejectedValue(new Error('Broker unavailable'));
    await expect(value.call('host-tasks:export-app', { label: 'App', instanceId: 'instance' })).rejects.toThrow();
    expect(existsSync(path)).toBe(false);
  });

  it('does not claim a runner is live or expose the admin secret in renderer state', async () => {
    const value = fixture('win32');
    const result = await value.call('host-tasks:get');
    expect(JSON.stringify(result)).not.toContain(adminCredential);
    expect(result).toMatchObject({ credentialReady: true, runnerBlockedReason: expect.stringContaining('Blocked') });
    expect(result).toMatchObject({ appProvisioningBlockedReason: expect.stringContaining('ACL verification') });
    expect(result).toMatchObject({ adminProvisioningBlockedReason: expect.stringContaining('Windows private-file ACL verifier') });
  });
});
