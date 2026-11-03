import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../control-plane/src/server';
import { DesktopInstanceIdentity } from '../src/main/instanceIdentity';
import { HostTaskCredentialVault } from '../src/main/hostTaskBroker';
import { HostScriptAdminClient } from '../src/main/hostScriptClient';

const servers: RunningServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

it('keeps Host tasks working against older backends without enabling unsupported Search', async () => {
  const vault = new HostTaskCredentialVault({ isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() }, process.platform, '/not-used');
  vault.setSession('http://127.0.0.1:7717', randomBytes(32).toString('hex'), Date.now() + 60_000);
  let hostTasks = true;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith('/features/v2')) return new Response('', { status: 404 });
    expect(String(url)).toContain('/features/v1');
    if (init?.method === 'POST') hostTasks = JSON.parse(String(init.body)).hostTasks;
    return Response.json({ hostTasks });
  });
  const identity = new DesktopInstanceIdentity(vault, async () => '', () => false, fetcher);
  expect(await identity.features('http://127.0.0.1:7717/mcp')).toEqual({ hostTasks: true, search: false });
  expect(await identity.setFeatures('http://127.0.0.1:7717/mcp', { hostTasks: false })).toEqual({ hostTasks: false, search: false });
  await expect(identity.setFeatures('http://127.0.0.1:7717/mcp', { search: true })).rejects.toThrow('does not support Search');
  const calls = fetcher.mock.calls.length;
  fetcher.mockResolvedValueOnce(new Response('', { status: 503 }));
  await expect(identity.features('http://127.0.0.1:7717/mcp')).rejects.toThrow('HTTP 503');
  expect(fetcher.mock.calls.length).toBe(calls + 1);
});

it('connects without Keychain or secret files, keeps the password transient, and revokes its session on logout', async () => {
  const bootstrap = randomBytes(32).toString('hex');
  const server = await startServer({ port: 0, hostTaskAdminCredential: bootstrap });
  servers.push(server);
  const native = { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() };
  const vault = new HostTaskCredentialVault(native, process.platform, '/not-used-session-only');
  const identity = new DesktopInstanceIdentity(vault, async () => bootstrap, () => true);
  const mcpUrl = `${server.url}/mcp`, password = 'a private owner password';
  expect(await identity.status(mcpUrl)).toEqual({ environment: server.url, authenticated: false,
    passwordConfigured: false, passwordHint: '', setupAvailable: true });
  const setup = await identity.signIn(mcpUrl, password, true, 'First owner reminder');
  vault.setSession(server.url, setup.token, setup.expiresAt);
  expect(await identity.features(mcpUrl)).toEqual({ hostTasks: false, search: false });
  await expect(new HostScriptAdminClient(mcpUrl, setup.token).scripts()).rejects.toThrow('turned off');
  expect(await identity.setFeatures(mcpUrl, { hostTasks: true })).toEqual({ hostTasks: true, search: false });
  expect(await vault.read(server.url)).toBe(setup.token);
  expect(await new HostScriptAdminClient(mcpUrl, setup.token).scripts()).toMatchObject({ tasks: [] });
  expect(await identity.status(mcpUrl)).toEqual({ environment: server.url, authenticated: true,
    passwordConfigured: true, passwordHint: 'First owner reminder', setupAvailable: true });
  await identity.setPasswordHint(mcpUrl, 'An updated reminder\nwith free text');
  expect((await identity.status(mcpUrl)).passwordHint).toBe('An updated reminder\nwith free text');
  await identity.signOut(mcpUrl);
  expect(vault.session(server.url)).toBeNull();
  await expect(identity.setFeatures(mcpUrl, { hostTasks: false })).rejects.toThrow('Sign in');
  expect((await identity.status(mcpUrl)).passwordHint).toBe('An updated reminder\nwith free text');
  await expect(identity.setPasswordHint(mcpUrl, 'not signed in')).rejects.toThrow('Sign in');
  await expect(new HostScriptAdminClient(mcpUrl, setup.token).scripts()).rejects.toThrow('401');
  await expect(identity.signIn(mcpUrl, 'incorrect', false)).rejects.toThrow('Incorrect password');
  const next = await identity.signIn(mcpUrl, password, false);
  expect(next.token).not.toBe(setup.token);
  expect(native.isEncryptionAvailable).not.toHaveBeenCalled();
  expect(native.encryptString).not.toHaveBeenCalled();
  expect(native.decryptString).not.toHaveBeenCalled();
});

it('refuses password setup for an instance without a trusted local bootstrap path', async () => {
  const vault = new HostTaskCredentialVault({ isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() }, process.platform, '/not-used');
  const bootstrap = vi.fn();
  const identity = new DesktopInstanceIdentity(vault, bootstrap, () => false);
  await expect(identity.signIn('http://127.0.0.1:7717/mcp', 'a private owner password', true)).rejects.toThrow('local instance owner');
  expect(bootstrap).not.toHaveBeenCalled();
});
