import { randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../control-plane/src/server';
import { DesktopInstanceIdentity } from '../src/main/instanceIdentity';
import { HostTaskCredentialVault } from '../src/main/hostTaskBroker';
import { HostScriptAdminClient } from '../src/main/hostScriptClient';

const servers: RunningServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });

it('connects without Keychain or secret files, keeps the password transient, and revokes its session on logout', async () => {
  const bootstrap = randomBytes(32).toString('hex');
  const server = await startServer({ port: 0, hostTaskAdminCredential: bootstrap });
  servers.push(server);
  const native = { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() };
  const vault = new HostTaskCredentialVault(native, process.platform, '/not-used-session-only');
  const identity = new DesktopInstanceIdentity(vault, async () => bootstrap, () => true);
  const mcpUrl = `${server.url}/mcp`, password = 'a private owner password';
  expect(await identity.status(mcpUrl)).toEqual({ passwordConfigured: false, passwordHint: '', setupAvailable: true });
  const setup = await identity.signIn(mcpUrl, password, true, 'First owner reminder');
  vault.setSession(server.url, setup.token, setup.expiresAt);
  expect(await vault.read(server.url)).toBe(setup.token);
  expect(await new HostScriptAdminClient(mcpUrl, setup.token).scripts()).toMatchObject({ tasks: [] });
  expect(await identity.status(mcpUrl)).toEqual({ passwordConfigured: true, passwordHint: 'First owner reminder', setupAvailable: true });
  await identity.setPasswordHint(mcpUrl, 'An updated reminder\nwith free text');
  expect((await identity.status(mcpUrl)).passwordHint).toBe('An updated reminder\nwith free text');
  await identity.signOut(mcpUrl);
  expect(vault.session(server.url)).toBeNull();
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
