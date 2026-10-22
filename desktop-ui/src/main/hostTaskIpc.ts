import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { HostTaskAppProvisionInput } from '../../../shared/hostTasks';
import type { HostTaskDesktopState, HostTaskGrantInput } from '../shared/hostTasks';
import {
  HOST_TASK_SCOPE,
  HostTaskAdminClient,
  HostTaskCredentialVault,
  WindowsHostTaskRunner,
  hostTaskOrigin,
  hostTaskId,
  validateGrant,
  validateHostTaskApp,
  validateHostTaskAppMetadata,
  reviewedHostTaskOperation,
  hostTaskOperationSummary,
  WINDOWS_HOST_TASK_ADMIN_IMPORT_BLOCKED,
} from './hostTaskBroker';

interface TrustedSender {
  sender: unknown;
  senderFrame: { url: string } | null;
}

interface TrustedWindow {
  webContents: { mainFrame: unknown };
  isDestroyed(): boolean;
}

export function assertHostTaskSender(event: TrustedSender, window: TrustedWindow | null, rendererUrl: string): void {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame) {
    throw new Error('Host-task administration requires the trusted desktop main frame.');
  }
  const expected = new URL(rendererUrl);
  const actual = new URL(event.senderFrame!.url);
  expected.hash = '';
  actual.hash = '';
  if (actual.href !== expected.href) {
    throw new Error('Host-task administration is not available to this page.');
  }
}

export interface HostTaskIpcDependencies {
  ipc: { handle(channel: string, handler: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void };
  dialog: Pick<typeof import('electron').dialog, 'showMessageBox' | 'showOpenDialog' | 'showSaveDialog'>;
  getWindow(): BrowserWindow | null;
  getEnvironment(): { mcpUrl: string; displayName: string } | null;
  rendererUrl: string;
  vault: HostTaskCredentialVault;
  platform: NodeJS.Platform;
  createClient?: (mcpUrl: string, token: string) => HostTaskAdminClient;
}

export function registerHostTaskIpc(deps: HostTaskIpcDependencies): void {
  const runner = new WindowsHostTaskRunner(deps.platform);
  const appProvisioningBlockedReason = deps.platform === 'win32'
    ? 'App credential provisioning is blocked: private Windows file ACL verification is not implemented.'
    : null;
  const adminProvisioningBlockedReason = deps.platform === 'win32' ? WINDOWS_HOST_TASK_ADMIN_IMPORT_BLOCKED : null;
  let active = false;
  const handle = (channel: string, action: (window: BrowserWindow, mcpUrl: string, ...args: any[]) => Promise<unknown>) => {
    deps.ipc.handle(channel, async (event, ...args) => {
      const window = deps.getWindow();
      assertHostTaskSender(event, window, deps.rendererUrl);
      const environment = deps.getEnvironment();
      if (!environment) throw new Error('Select a Working Memory environment first.');
      hostTaskOrigin(environment.mcpUrl);
      if (active) throw new Error('Another host-task administration operation is in progress.');
      active = true;
      try {
        const result = await action(window!, environment.mcpUrl, ...args);
        ensureCurrent(window!, environment.mcpUrl);
        return result;
      } finally {
        active = false;
      }
    });
  };
  const ensureCurrent = (window: BrowserWindow, mcpUrl: string) => {
    if (window !== deps.getWindow() || window.isDestroyed() || deps.getEnvironment()?.mcpUrl !== mcpUrl) {
      throw new Error('Desktop window or selected environment changed; retry the operation.');
    }
    assertHostTaskSender({
      sender: window.webContents, senderFrame: window.webContents.mainFrame,
    }, window, deps.rendererUrl);
  };
  const client = async (mcpUrl: string) => {
    const token = await deps.vault.read(hostTaskOrigin(mcpUrl));
    if (!token) throw new Error('Provision the broker admin token using the native file picker first.');
    return deps.createClient?.(mcpUrl, token) ?? new HostTaskAdminClient(mcpUrl, token);
  };
  const confirm = async (window: BrowserWindow, mcpUrl: string, message: string, detail: string, thriveScope = true) => {
    const result = await deps.dialog.showMessageBox(window, {
      type: 'warning', title: 'Host-task approval', message,
      detail: `Environment: ${hostTaskOrigin(mcpUrl)}\n\n${detail}${thriveScope ? `\n\n${HOST_TASK_SCOPE}` : ''}`,
      buttons: ['Cancel', 'Approve'], defaultId: 0, cancelId: 0, noLink: true,
    });
    ensureCurrent(window, mcpUrl);
    return result.response === 1;
  };

  handle('host-tasks:get', async (_window, mcpUrl): Promise<HostTaskDesktopState> => {
    const token = await deps.vault.read(hostTaskOrigin(mcpUrl));
    return {
      environment: hostTaskOrigin(mcpUrl), credentialReady: !!token,
      runnerBlockedReason: runner.blockedReason(),
      appProvisioningBlockedReason,
      adminProvisioningBlockedReason,
      snapshot: token ? await (deps.createClient?.(mcpUrl, token) ?? new HostTaskAdminClient(mcpUrl, token)).snapshot() : null,
    };
  });

  handle('host-tasks:provision-admin', async (window, mcpUrl) => {
    if (adminProvisioningBlockedReason) throw new Error(adminProvisioningBlockedReason);
    if (!await confirm(window, mcpUrl, 'Import the separately configured broker admin token?',
      'Choose the private file configured externally through WM_HOST_TASK_ADMIN_TOKEN_FILE. '
      + 'It is copied only into OS-encrypted safeStorage, bound to this environment; never into MCP, documents, or app configuration.', false)) return;
    const selected = await deps.dialog.showOpenDialog(window, {
      title: 'Select private broker admin token file', properties: ['openFile'],
    });
    ensureCurrent(window, mcpUrl);
    if (selected.canceled || selected.filePaths.length !== 1) return;
    await deps.vault.import(hostTaskOrigin(mcpUrl), selected.filePaths[0]);
  });

  handle('host-tasks:export-app', async (window, mcpUrl, input: HostTaskAppProvisionInput) => {
    if (appProvisioningBlockedReason) throw new Error(appProvisioningBlockedReason);
    const app = validateHostTaskApp(input);
    if (!await confirm(window, mcpUrl, 'Provision an app credential to a new private file?',
      `App: ${app.label}\nInstance: ${app.instanceId}\n`
      + 'The credential will never be shown in the renderer. Choose a NEW file outside repositories and synced folders. '
      + 'Protect it as a Docker secret, mount it read-only into this app only, and never put it in editable claims, images, or environment configuration.', false)) return;
    const selected = await deps.dialog.showSaveDialog(window, {
      title: 'Export private app credential (new file only)', defaultPath: 'host-task-app.secret',
      buttonLabel: 'Create private secret file',
    });
    ensureCurrent(window, mcpUrl);
    if (selected.canceled || !selected.filePath) return;
    const file = await open(selected.filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
      | (constants.O_NOFOLLOW ?? 0), 0o600);
    let complete = false;
    try {
      const broker = await client(mcpUrl);
      ensureCurrent(window, mcpUrl);
      const provisioned = await broker.createApp(app);
      await file.writeFile(`${provisioned.credential}\n`);
      await file.sync();
      complete = true;
    } finally {
      await file.close();
      if (!complete) await unlink(selected.filePath).catch(() => undefined);
    }
  });

  handle('host-tasks:approve', async (window, mcpUrl, input: HostTaskGrantInput) => {
    const grant = validateGrant(input);
    const broker = await client(mcpUrl);
    const snapshot = await broker.snapshot();
    const operation = reviewedHostTaskOperation(snapshot.policy.operation, snapshot.policy.policyHash);
    const app = snapshot.apps.find((candidate) => candidate.id === grant.appId);
    ensureCurrent(window, mcpUrl);
    if (!app) throw new Error('The selected host-task app is no longer registered. Refresh and retry.');
    if (app.revokedAt !== null) throw new Error('This app credential is revoked. Provision a new app before approving access.');
    const display = validateHostTaskAppMetadata(app);
    if (!await confirm(window, mcpUrl, 'Approve this expiring host-task grant?',
      `App: ${JSON.stringify(display.label)} (${app.id})\nInstance: ${JSON.stringify(display.instanceId)}\n`
      + `Declared Windows SID: ${grant.windowsSid}\nDeclared tenant: ${grant.tenantId}\n`
      + `Expires: ${new Date(grant.expiresAt).toISOString()}\nIdentity declarations are not verification; execution stays blocked until independently verified. `
      + `You can revoke this grant at any time.\n\n${hostTaskOperationSummary(operation, snapshot.policy.policyHash)}`)) return;
    ensureCurrent(window, mcpUrl);
    await broker.grant(grant, snapshot.policy);
  });

  handle('host-tasks:revoke', async (window, mcpUrl, rawId: string) => {
    const id = hostTaskId(rawId);
    if (!await confirm(window, mcpUrl, 'Revoke this host-task grant?', `Grant: ${id}\nFuture execution must stop.`)) return;
    const broker = await client(mcpUrl);
    ensureCurrent(window, mcpUrl);
    await broker.revoke(id);
  });

  handle('host-tasks:revoke-app', async (window, mcpUrl, rawId: string) => {
    const id = hostTaskId(rawId);
    const broker = await client(mcpUrl);
    const app = (await broker.snapshot()).apps.find((candidate) => candidate.id === id);
    ensureCurrent(window, mcpUrl);
    if (!app) throw new Error('The selected host-task app is no longer registered. Refresh and retry.');
    const display = validateHostTaskAppMetadata(app);
    if (!await confirm(window, mcpUrl, 'Revoke this app credential and its host-task access?',
      `App: ${JSON.stringify(display.label)} (${app.id})\nInstance: ${JSON.stringify(display.instanceId)}\n`
      + 'This invalidates the app credential, revokes its grants and cancels outstanding jobs. '
      + 'Remove the exported secret file and its Docker secret mount yourself; the desktop will not access Docker or delete your file.')) return;
    ensureCurrent(window, mcpUrl);
    await broker.revokeApp(id);
  });

  handle('host-tasks:deny', async (window, mcpUrl, rawId: string) => {
    const id = hostTaskId(rawId);
    if (!await confirm(window, mcpUrl, 'Deny this queued host-task job?', `Job: ${id}`)) return;
    const broker = await client(mcpUrl);
    ensureCurrent(window, mcpUrl);
    await broker.deny(id);
  });
}
