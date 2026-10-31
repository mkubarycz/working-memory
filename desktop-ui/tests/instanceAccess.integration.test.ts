import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { IpcMainInvokeEvent } from 'electron';
import { startServer } from '../../control-plane/src/server';
import { openStore } from '../../control-plane/src/store';
import { InstanceIdentity } from '../../control-plane/src/instanceIdentity';
import { InstanceAccess } from '../../control-plane/src/instanceAccess';
import { ControlPlaneClient } from '../../shared/controlPlaneClient';
import { HostTaskCredentialVault } from '../src/main/hostTaskBroker';
import { DesktopInstanceIdentity } from '../src/main/instanceIdentity';
import { registerInstanceIdentityIpc } from '../src/main/instanceIdentityIpc';
import { loadKinds } from '../../control-plane/src/kinds/loader';
import { defaultInstancePermissions } from '../../control-plane/src/instancePermissions';
import { DEFAULT_SESSION_POLICY, sessionSnapshotSchema } from '../../control-plane/src/sessionPolicy';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  await loadKinds();
  const store = openStore(':memory:'), bootstrap = randomBytes(32).toString('base64url');
  const server = await startServer({ port: 0, store, hostTaskAdminCredential: bootstrap });
  cleanup.push(async () => { await server.close(); store.close(); });
  const vault = new HostTaskCredentialVault({
    isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn(),
  }, process.platform, '/not-used');
  const unauthorized = vi.fn();
  const identity = new DesktopInstanceIdentity(vault, async () => bootstrap, () => true, fetch, unauthorized);
  const environment = { mcpUrl: `${server.url}/mcp`, displayName: 'Test' };
  const rendererUrl = 'file:///working-memory/renderer/index.html', frame = { url: rendererUrl };
  const window = { webContents: { mainFrame: frame }, isDestroyed: () => false };
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 0 }), showOpenDialog: vi.fn(), showSaveDialog: vi.fn() };
  const changed = vi.fn().mockResolvedValue(undefined);
  registerInstanceIdentityIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    dialog, vault, identity, getWindow: () => window, getEnvironment: () => environment,
    rendererUrl, platform: process.platform, onSessionChanged: changed,
  } as unknown as Parameters<typeof registerInstanceIdentityIpc>[0]);
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  return { store, server, vault, identity, unauthorized, environment, event, handlers, dialog, changed, call };
}

it('reads and saves owner session diagnostics through trusted, environment-bound IPC', async () => {
  const f = await fixture();
  await expect(f.call('instance:sessions')).rejects.toThrow('Sign in');
  f.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await f.call('instance:sign-in', { password: 'my private owner password', setup: true });
  const snapshot = sessionSnapshotSchema.parse(await f.call('instance:sessions'));
  expect(snapshot.policy).toEqual(DEFAULT_SESSION_POLICY);
  await f.call('instance:session-policy', { mcpUrl: f.environment.mcpUrl, policy: { ...DEFAULT_SESSION_POLICY, idleMinutes: 70 } });
  expect(sessionSnapshotSchema.parse(await f.call('instance:sessions')).policy.idleMinutes).toBe(70);
  await expect(f.call('instance:sessions', -1)).rejects.toThrow();
  await expect(f.call('instance:session-policy', {
    mcpUrl: f.environment.mcpUrl, policy: { ...DEFAULT_SESSION_POLICY, retentionDays: 0 },
  })).rejects.toThrow();
  await expect(f.call('instance:session-policy', {
    mcpUrl: 'http://127.0.0.1:9999/mcp', policy: DEFAULT_SESSION_POLICY,
  })).rejects.toThrow('selected instance changed');
  expect(sessionSnapshotSchema.parse(await f.call('instance:sessions')).policy.idleMinutes).toBe(70);
  const invalidEvent = { ...f.event, senderFrame: { url: 'https://untrusted.invalid' } } as unknown as IpcMainInvokeEvent;
  await expect(f.handlers.get('instance:sessions')!(invalidEvent)).rejects.toThrow();
  const pending = f.call('instance:sessions');
  f.environment.mcpUrl = 'http://127.0.0.1:9999/mcp';
  await expect(pending).rejects.toThrow('selected instance changed');
});

it('serializes policy saves across view lifetimes and continues after a failed save', async () => {
  const f = await fixture();
  f.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await f.call('instance:sign-in', { password: 'my private owner password', setup: true });
  const original = f.identity.sessions.bind(f.identity);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const sessions = vi.spyOn(f.identity, 'sessions').mockImplementationOnce(async (...args) => {
    started(); await waiting;
    return original(...args);
  });
  const save = (idleMinutes: number) => f.call('instance:session-policy', {
    mcpUrl: f.environment.mcpUrl, policy: { ...DEFAULT_SESSION_POLICY, idleMinutes },
  });
  try {
    const first = save(61);
    await running;
    const second = save(62);
    const reading = f.call('instance:sessions');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(sessions).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    const snapshot = sessionSnapshotSchema.parse(await reading);
    expect(snapshot.policy.idleMinutes).toBe(62);
    await f.call('instance:session-policy', { mcpUrl: f.environment.mcpUrl,
      policy: { ...snapshot.policy, retentionDays: 11 } });
    expect(sessionSnapshotSchema.parse(await f.call('instance:sessions')).policy).toMatchObject({
      idleMinutes: 62, retentionDays: 11,
    });
    sessions.mockRejectedValueOnce(new Error('test policy save failure'));
    const failure = expect(save(63)).rejects.toThrow('test policy save failure');
    const afterFailure = f.call('instance:sessions');
    await failure;
    expect(sessionSnapshotSchema.parse(await afterFailure).policy.idleMinutes).toBe(62);
    await save(64);
    expect(sessionSnapshotSchema.parse(await f.call('instance:sessions')).policy.idleMinutes).toBe(64);
  } finally { release(); sessions.mockRestore(); }
});

it('rejects queued policy writes if the selected instance changes before they start', async () => {
  const f = await fixture();
  f.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await f.call('instance:sign-in', { password: 'my private owner password', setup: true });
  const original = f.identity.sessions.bind(f.identity);
  const mcpUrl = f.environment.mcpUrl;
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const running = new Promise<void>(resolve => { started = resolve; });
  const sessions = vi.spyOn(f.identity, 'sessions').mockImplementationOnce(async (...args) => {
    started(); await waiting;
    return original(...args);
  });
  try {
    const first = f.call('instance:session-policy', { mcpUrl, policy: { ...DEFAULT_SESSION_POLICY, idleMinutes: 61 } });
    await running;
    const second = f.call('instance:session-policy', { mcpUrl, policy: { ...DEFAULT_SESSION_POLICY, idleMinutes: 62 } });
    const reading = f.call('instance:sessions');
    const results = Promise.allSettled([first, second, reading]);
    f.environment.mcpUrl = 'http://127.0.0.1:9999/mcp';
    release();
    expect(await results).toMatchObject([
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('selected instance changed') }) },
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('selected instance changed') }) },
      { status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('selected instance changed') }) },
    ]);
    expect(sessions).toHaveBeenCalledTimes(1);
    expect((await original(mcpUrl)).policy.idleMinutes).toBe(61);
  } finally { release(); sessions.mockRestore(); }
});

it('guides initial setup through native approval and uses one isolated owner session for all data', async () => {
  const f = await fixture();
  expect(await f.call('instance:identity')).toMatchObject({ passwordConfigured: false, authenticated: false, setupAvailable: true });
  const input = { password: 'my private owner password', setup: true, passwordHint: 'Only a reminder' };
  await f.call('instance:sign-in', input);
  expect(new InstanceIdentity(f.store.db).configured()).toBe(false);
  expect(f.vault.session(f.server.url)).toBeNull();
  f.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await f.call('instance:sign-in', input);
  const state = await f.call('instance:identity');
  expect(state).toMatchObject({ passwordConfigured: true, authenticated: true, passwordHint: 'Only a reminder' });
  const token = f.vault.session(f.server.url);
  expect(token).toBeTruthy();
  expect(JSON.stringify(state)).not.toContain(token!);
  expect(JSON.stringify(state)).not.toContain(input.password);
  expect(f.changed).toHaveBeenCalledWith(f.environment.mcpUrl, true);
  const client = new ControlPlaneClient({ resolveUrl: () => f.environment.mcpUrl, getToken: () => f.vault.session(f.server.url) });
  cleanup.push(() => client.dispose());
  expect((await client.listDocuments()).available).toBe(true);
  await f.call('instance:sign-out');
  expect(f.vault.session(f.server.url)).toBeNull();
  expect(f.changed).toHaveBeenCalledWith(f.environment.mcpUrl, false);
  expect((await client.listDocuments()).error).toMatch(/sign-in|identity\/v1\/mcp/i);
});

it('approves agent requests with one explicit owner action, no second dialog, and no credential exposure in IPC', async () => {
  const f = await fixture();
  f.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await f.call('instance:sign-in', { password: 'my private owner password', setup: true });
  const access = new InstanceAccess(f.store.db, new InstanceIdentity(f.store.db));
  const request = access.request({ label: 'Coding agent', access: 'write', refresh: false }, '', 'test source');
  const action = { id: request.requestId, action: 'approve' };
  expect(access.claim(request.requestId, request.requestSecret).state).toBe('pending');
  f.dialog.showMessageBox.mockClear();
  const invalidEvent = { ...f.event, senderFrame: { url: 'https://untrusted.invalid' } } as unknown as IpcMainInvokeEvent;
  await expect(f.handlers.get('instance:review-access')!(invalidEvent, action)).rejects.toThrow();
  expect(access.claim(request.requestId, request.requestSecret).state).toBe('pending');
  await f.call('instance:review-access', action);
  expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
  await expect(f.call('instance:review-access', action)).rejects.toThrow('expired or was already reviewed');
  const issued = access.claim(request.requestId, request.requestSecret);
  if (!('token' in issued)) throw new Error('Expected approved credential');
  const snapshot = JSON.stringify(await f.call('instance:access'));
  expect(snapshot).not.toContain(issued.token);
  expect(snapshot).not.toContain(request.requestSecret);
  await f.call('instance:review-access', { id: issued.clientId, action: 'revoke' });
  expect(access.authenticate(issued.token)).toBeNull();
});

it('clears revoked sessions and signals the global connection screen instead of returning data', async () => {
  const f = await fixture();
  f.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await f.call('instance:sign-in', { password: 'my private owner password', setup: true });
  new InstanceIdentity(f.store.db).revoke(f.vault.session(f.server.url)!);
  expect(await f.call('instance:identity')).toMatchObject({ authenticated: false });
  expect(f.vault.session(f.server.url)).toBeNull();
  expect(f.unauthorized).toHaveBeenCalledWith(f.environment.mcpUrl);
});

it('persists checkbox permissions through trusted IPC without a confirmation dialog or exposing credentials', async () => {
  const f = await fixture();
  f.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await f.call('instance:sign-in', { password: 'my private owner password', setup: true });
  const access = new InstanceAccess(f.store.db, new InstanceIdentity(f.store.db));
  const request = access.request({ label: 'Permission editor', access: 'write', refresh: false }, '', 'test');
  const permissions = defaultInstancePermissions('read');
  permissions.settings.read = false;
  const action = { id: request.requestId, action: 'permissions', target: 'request', permissions };
  f.dialog.showMessageBox.mockClear();
  const snapshot = JSON.stringify(await f.call('instance:review-access', action));
  expect(snapshot).toContain('"settings":{"create":false,"read":false,"update":false,"delete":false}');
  expect(snapshot).not.toContain(request.requestSecret);
  expect(f.dialog.showMessageBox).not.toHaveBeenCalled();
  await f.call('instance:review-access', { id: request.requestId, action: 'approve' });
  const issued = access.claim(request.requestId, request.requestSecret);
  if (!('token' in issued)) throw new Error('Expected approved credential');
  permissions.content.create = true;
  await f.call('instance:review-access', { ...action, id: issued.clientId, target: 'client' });
  expect(access.authenticate(issued.token)?.permissions).toEqual(permissions);
  await expect(f.call('instance:review-access', { ...action, target: 'owner' })).rejects.toThrow();
});

it('allows the signed-in owner to change or clear the public hint while Host tasks remains disabled', async () => {
  const f = await fixture();
  f.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await f.call('instance:sign-in', { password: 'my private owner password', setup: true });
  expect(await f.identity.features(f.environment.mcpUrl)).toEqual({ hostTasks: false });
  await f.identity.setPasswordHint(f.environment.mcpUrl, 'A public reminder');
  expect(await f.call('instance:identity')).toMatchObject({ passwordHint: 'A public reminder' });
  await f.identity.setPasswordHint(f.environment.mcpUrl, '');
  expect(await f.call('instance:identity')).toMatchObject({ passwordHint: '' });
  expect(await f.identity.features(f.environment.mcpUrl)).toEqual({ hostTasks: false });
});

it('does not let a delayed anonymous status response clear a newly established owner session', async () => {
  const f = await fixture();
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  let first = true;
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    if (first) { first = false; started(); await waiting; }
    return response;
  };
  const identity = new DesktopInstanceIdentity(f.vault, async () => '', () => true, fetcher, f.unauthorized);
  const status = identity.status(f.environment.mcpUrl);
  await requested;
  f.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await f.call('instance:sign-in', { password: 'my private owner password', setup: true });
  const token = f.vault.session(f.server.url);
  f.unauthorized.mockClear();
  release();
  expect(await status).toMatchObject({ authenticated: true });
  expect(f.vault.session(f.server.url)).toBe(token);
  expect(f.unauthorized).not.toHaveBeenCalled();
});

it('does not let a delayed rejection of an old credential revoke a replacement session', async () => {
  const f = await fixture();
  f.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  await f.call('instance:sign-in', { password: 'my private owner password', setup: true });
  new InstanceIdentity(f.store.db).revoke(f.vault.session(f.server.url)!);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  const fetcher: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    started(); await waiting;
    return response;
  };
  const identity = new DesktopInstanceIdentity(f.vault, async () => '', () => true, fetcher, f.unauthorized);
  const features = expect(identity.features(f.environment.mcpUrl)).rejects.toThrow('expired session');
  await requested;
  await f.call('instance:sign-in', { password: 'my private owner password', setup: false });
  const token = f.vault.session(f.server.url);
  f.unauthorized.mockClear();
  release();
  await features;
  expect(f.vault.session(f.server.url)).toBe(token);
  expect(f.unauthorized).not.toHaveBeenCalled();
});
