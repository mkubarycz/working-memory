import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer } from '../../control-plane/src/server';
import { InstancePasswordVault } from '../src/main/instancePasswordVault';
import { HostTaskCredentialVault } from '../src/main/hostTaskBroker';
import { DesktopInstanceIdentity } from '../src/main/instanceIdentity';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function storage(platform: NodeJS.Platform = 'darwin', backend = 'gnome_libsecret') {
  const directory = await mkdtemp(join(tmpdir(), 'wm-instance-password-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const native = {
    isEncryptionAvailable: vi.fn(() => true),
    getSelectedStorageBackend: vi.fn(() => backend),
    encryptString: vi.fn((value: string) => {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    }),
    decryptString: vi.fn((value: Buffer) => {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
    }),
  };
  return { directory, native, passwords: new InstancePasswordVault(native, platform, directory) };
}

async function fixture() {
  const s = await storage();
  const bootstrap = randomBytes(32).toString('base64url');
  const server = await startServer({ port: 0, hostTaskAdminCredential: bootstrap });
  cleanup.push(() => server.close());
  const make = (fetcher: typeof fetch = fetch) => {
    const vault = new HostTaskCredentialVault(s.native, 'darwin', s.directory);
    const identity = new DesktopInstanceIdentity(vault, async () => bootstrap, () => true, fetcher, vi.fn(), s.passwords);
    return { vault, identity };
  };
  return { ...s, server, make, mcpUrl: `${server.url}/mcp`, password: 'A private remembered owner password' };
}

it('writes only native ciphertext atomically and restores it across UI sessions, isolated by origin', async () => {
  const { directory, native, passwords } = await storage();
  const origin = 'http://127.0.0.1:7717', password = 'A private owner password';
  expect(await passwords.read(origin)).toBeNull();
  await passwords.save(origin, password);
  const files = await readdir(directory);
  expect(files).toHaveLength(1);
  expect(files[0]).toMatch(/^[a-f0-9]{64}\.bin$/);
  const file = join(directory, files[0]);
  expect((await readFile(file)).includes(Buffer.from(password))).toBe(false);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  const otherUi = new InstancePasswordVault(native, 'darwin', directory);
  expect(await otherUi.read(origin)).toBe(password);
  expect(await otherUi.read('http://127.0.0.1:7727')).toBeNull();
  await passwords.forget(origin);
  expect(await otherUi.read(origin)).toBeNull();
});

it.each(['basic_text', 'unknown'])('rejects insecure Linux storage backend %s without writing a password', async backend => {
  const { native, passwords, directory } = await storage('linux', backend);
  expect(passwords.available()).toBe(false);
  await expect(passwords.save('http://127.0.0.1:7717', 'password')).rejects.toThrow('Native secure storage is unavailable');
  expect(native.encryptString).not.toHaveBeenCalled();
  expect(await readdir(directory)).toEqual([]);
});

it.each(['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'])('permits the native Linux backend %s', async backend => {
  const { passwords } = await storage('linux', backend);
  expect(passwords.available()).toBe(true);
});

it('rejects swapped or corrupted ciphertext and never imports another instance password', async () => {
  const { passwords, directory } = await storage();
  const first = 'http://127.0.0.1:7717', second = 'http://127.0.0.1:7727';
  await passwords.save(first, 'First private password');
  const [source] = await readdir(directory);
  await passwords.save(second, 'Second private password');
  const target = (await readdir(directory)).find(file => file !== source)!;
  await copyFile(join(directory, source), join(directory, target));
  await expect(passwords.read(second)).rejects.toThrow('Cannot unlock remembered sign-in');
  await writeFile(join(directory, source), 'corrupted');
  await expect(passwords.read(first)).rejects.toThrow('Cannot unlock remembered sign-in');
  await passwords.forget(first);
  await passwords.forget(second);
});

it('surfaces native encryption denial without using a local key or plaintext fallback', async () => {
  const { passwords, native, directory } = await storage();
  native.encryptString.mockImplementation(() => { throw new Error('Keychain access denied'); });
  await expect(passwords.save('http://127.0.0.1:7717', 'private password')).rejects.toThrow('no plaintext fallback');
  expect(await readdir(directory)).toEqual([]);
});

it('continues to unlock version-one passwords saved by the installed remembered-sign-in build', async () => {
  const { passwords, native, directory } = await storage();
  const origin = 'http://127.0.0.1:7717', password = 'Existing native remembered password';
  await passwords.save(origin, password);
  const [file] = await readdir(directory);
  await writeFile(join(directory, file), native.encryptString(JSON.stringify({ version: 1, origin, password })));
  expect(await passwords.read(origin)).toBe(password);
});

it('remembers a verified password, restores a new owner session after restart and expiry, and forgets on sign-out', async () => {
  const f = await fixture(), first = f.make();
  const initial = await first.identity.signIn(f.mcpUrl, f.password, true, '', true);
  const second = f.make();
  const state = await second.identity.status(f.mcpUrl);
  expect(state).toMatchObject({ authenticated: true, rememberPasswordAvailable: true });
  const token = second.vault.session(f.server.url);
  expect(token).toBeTruthy();
  expect(token).not.toBe(initial.token);
  expect(JSON.stringify(state)).not.toContain(f.password);
  expect(JSON.stringify(state)).not.toContain(token!);
  second.vault.setSession(f.server.url, token!, Date.now() + 1);
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 1000);
  expect((await second.identity.status(f.mcpUrl)).authenticated).toBe(true);
  expect(second.vault.session(f.server.url)).not.toBe(token);
  clock.mockRestore();
  await second.identity.signOut(f.mcpUrl);
  expect((await f.make().identity.status(f.mcpUrl)).authenticated).toBe(false);
  expect(await readdir(f.directory)).toEqual([]);
});

it('does not require or touch native encryption for session-only sign-in', async () => {
  const f = await fixture();
  f.native.isEncryptionAvailable.mockReturnValue(false);
  const { identity } = f.make();
  await expect(identity.signIn(f.mcpUrl, f.password, true, '', true)).rejects.toThrow('secure storage is unavailable');
  await identity.signIn(f.mcpUrl, f.password, true, '', false);
  expect((await identity.status(f.mcpUrl)).authenticated).toBe(true);
  expect(f.native.encryptString).not.toHaveBeenCalled();
  expect(f.native.decryptString).not.toHaveBeenCalled();
  expect(await readdir(f.directory)).toEqual([]);
});

it('removes an existing remembered password when the user signs in without Remember', async () => {
  const f = await fixture();
  await f.make().identity.signIn(f.mcpUrl, f.password, true, '', true);
  await f.make().identity.signIn(f.mcpUrl, f.password, false, '', false);
  expect(await f.passwords.read(f.server.url)).toBeNull();
});

it('shows restoration failures once and still permits manual sign-in without secure storage', async () => {
  const f = await fixture();
  await f.make().identity.signIn(f.mcpUrl, f.password, true, '', true);
  f.native.decryptString.mockImplementation(() => { throw new Error('Keychain is locked'); });
  const { identity } = f.make();
  expect(await identity.status(f.mcpUrl)).toMatchObject({
    authenticated: false, rememberPasswordError: expect.stringContaining('Cannot unlock remembered sign-in'),
  });
  await identity.status(f.mcpUrl);
  expect(f.native.decryptString).toHaveBeenCalledTimes(1);
  await identity.signIn(f.mcpUrl, f.password, false, '', false);
  expect(await identity.status(f.mcpUrl)).toMatchObject({ authenticated: true, rememberPasswordError: undefined });
});

it('coalesces simultaneous restoration attempts into one login', async () => {
  const f = await fixture();
  await f.make().identity.signIn(f.mcpUrl, f.password, true, '', true);
  const fetcher = vi.fn(fetch), { identity } = f.make(fetcher);
  const states = await Promise.all([identity.status(f.mcpUrl), identity.status(f.mcpUrl)]);
  expect(states.every(state => state.authenticated)).toBe(true);
  expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/identity/v1/login'))).toHaveLength(1);
});

it('does not let late automatic sign-in undo an explicit sign-out', async () => {
  const f = await fixture();
  await f.make().identity.signIn(f.mcpUrl, f.password, true, '', true);
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { started = resolve; });
  const fetcher: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (String(url).endsWith('/identity/v1/login')) { started(); await waiting; }
    return response;
  };
  const { identity, vault } = f.make(fetcher);
  const status = identity.status(f.mcpUrl);
  await requested;
  await identity.signOut(f.mcpUrl);
  release();
  expect((await status).authenticated).toBe(false);
  expect(vault.session(f.server.url)).toBeNull();
  expect(await f.passwords.read(f.server.url)).toBeNull();
});
