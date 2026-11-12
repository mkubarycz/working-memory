import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../control-plane/src/server';
import { DesktopInstanceIdentity } from '../src/main/instanceIdentity';
import { HostTaskCredentialVault } from '../src/main/hostTaskBroker';
import { HostScriptAdminClient } from '../src/main/hostScriptClient';
import { DEFAULT_TOOL_QUEUE_SETTINGS } from '../../control-plane/src/diagnosticContract';

const servers: RunningServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map(server => server.close()));
});

it('updates queue settings through authenticated HTTP and surfaces rejected saves without clearing credentials', async () => {
  const origin = 'http://127.0.0.1:7717', token = randomBytes(32).toString('hex');
  const vault = new HostTaskCredentialVault({ isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() }, process.platform, '/not-used');
  vault.setSession(origin, token, Date.now() + 60000);
  const settings = { ...DEFAULT_TOOL_QUEUE_SETTINGS, maxConcurrency: 2 };
  const update = { expectedBootId: '00000000-0000-4000-8000-000000000001', expectedSettings: DEFAULT_TOOL_QUEUE_SETTINGS, settings };
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({
    bootId: update.expectedBootId, observedAt: Date.now(), settings, limits: { running: 2, waiting: 16, waitMs: 5000 },
    memoryBlocked: false, running: 0, waiting: 0, items: [], events: [], history: [],
  }));
  const identity = new DesktopInstanceIdentity(vault, async () => '', () => false, fetcher);
  expect((await identity.updateToolQueueSettings(`${origin}/mcp`, update)).settings).toEqual(settings);
  expect(fetcher.mock.calls[0][0]).toBe(`${origin}/identity/v1/tool-queue/settings`);
  expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'POST', body: JSON.stringify(update) });
  fetcher.mockResolvedValueOnce(Response.json({ error: 'Queue settings changed' }, { status: 409 }));
  await expect(identity.updateToolQueueSettings(`${origin}/mcp`, update)).rejects.toThrow('Queue settings changed');
  expect(vault.session(origin)).toBe(token);
});

it('creates an authenticated SQLite snapshot through the backend-owned database handle', async () => {
  const bootstrap = randomBytes(32).toString('hex');
  const server = await startServer({ port: 0, hostTaskAdminCredential: bootstrap });
  servers.push(server);
  const vault = new HostTaskCredentialVault({ isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() }, process.platform, '/not-used');
  const identity = new DesktopInstanceIdentity(vault, async () => bootstrap, () => true);
  const mcpUrl = `${server.url}/mcp`, id = randomUUID();
  const snapshot = join(tmpdir(), `working-memory-${id}.sqlite`);
  try {
    const anonymous = await fetch(`${server.url}/identity/v1/backups`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    expect(anonymous.status).toBe(401);
    expect(existsSync(snapshot)).toBe(false);
    await expect(identity.createDatabaseBackup(mcpUrl, id)).rejects.toThrow('Sign in as the instance owner');
    await identity.signIn(mcpUrl, 'a private owner password', true);
    const token = vault.session(server.url);
    if (!token) throw new Error('Owner session was not established.');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (const [path, options, expected] of [
      ['', { method: 'GET', headers }, 405],
      ['?id=ignored', { method: 'POST', headers, body: JSON.stringify({ id }) }, 400],
      ['', { method: 'POST', headers: { ...headers, Origin: 'http://localhost' }, body: JSON.stringify({ id }) }, 400],
      ['', { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' }, 415],
      ['', { method: 'POST', headers, body: JSON.stringify({ id: '../journal.sqlite' }) }, 400],
      ['', { method: 'POST', headers, body: JSON.stringify({ id, path: '/data/journal.sqlite' }) }, 400],
      ['', { method: 'POST', headers, body: '{' }, 400],
    ] as const) {
      expect((await fetch(`${server.url}/identity/v1/backups${path}`, options)).status).toBe(expected);
      expect(existsSync(snapshot)).toBe(false);
    }
    await identity.createDatabaseBackup(mcpUrl, id);
    expect(existsSync(snapshot)).toBe(true);
    const database = new DatabaseSync(snapshot, { readOnly: true });
    try {
      expect(database.prepare('PRAGMA quick_check').get()?.quick_check).toBe('ok');
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resources'").get()).toBeTruthy();
    } finally {
      database.close();
    }
  } finally {
    rmSync(snapshot, { force: true });
  }
});

it('explains identity timeouts without clearing the session, then accepts recovery or authoritative revocation', async () => {
  const origin = 'http://127.0.0.1:7717', token = randomBytes(32).toString('hex');
  const vault = new HostTaskCredentialVault({ isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() }, process.platform, '/not-used');
  vault.setSession(origin, token, Date.now() + 60_000);
  const timeout = AbortSignal.abort(new DOMException('Timed out', 'TimeoutError'));
  const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(timeout);
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    init?.signal?.throwIfAborted();
    return Response.json({ passwordConfigured: true, passwordHint: '', authenticated: true, scope: 'instance' });
  });
  const unauthorized = vi.fn();
  const identity = new DesktopInstanceIdentity(vault, async () => '', () => false, fetcher, unauthorized);
  await expect(identity.status(`${origin}/mcp`)).rejects.toThrow('timed out after 10 seconds (GET /identity/v1/status)');
  expect(timer).toHaveBeenCalledWith(10_000);
  expect(vault.session(origin)).toBe(token);
  expect(unauthorized).not.toHaveBeenCalled();
  expect((await identity.status(`${origin}/mcp`)).authenticated).toBe(true);
  fetcher.mockResolvedValueOnce(Response.json({ passwordConfigured: true, passwordHint: '', authenticated: false, scope: 'instance' }));
  expect((await identity.status(`${origin}/mcp`)).authenticated).toBe(false);
  expect(vault.session(origin)).toBeNull();
  expect(unauthorized).toHaveBeenCalledWith(`${origin}/mcp`);
});

it('preserves caller cancellation and still clears a rejected owner session on HTTP 401', async () => {
  const origin = 'http://127.0.0.1:7717', token = randomBytes(32).toString('hex');
  const vault = new HostTaskCredentialVault({ isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() }, process.platform, '/not-used');
  vault.setSession(origin, token, Date.now() + 60_000);
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    init?.signal?.throwIfAborted();
    return new Response('', { status: 401 });
  });
  const unauthorized = vi.fn();
  const identity = new DesktopInstanceIdentity(vault, async () => '', () => false, fetcher, unauthorized);
  const cancellation = new Error('Instance changed');
  await expect(identity.features(`${origin}/mcp`, AbortSignal.abort(cancellation))).rejects.toBe(cancellation);
  expect(vault.session(origin)).toBe(token);
  expect(unauthorized).not.toHaveBeenCalled();
  await expect(identity.status(`${origin}/mcp`)).rejects.toThrow('expired session');
  expect(vault.session(origin)).toBeNull();
  expect(unauthorized).toHaveBeenCalledWith(`${origin}/mcp`);
});

it('keeps Host tasks working against older backends without enabling unsupported Search', async () => {
  const vault = new HostTaskCredentialVault({ isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn() }, process.platform, '/not-used');
  vault.setSession('http://127.0.0.1:7717', randomBytes(32).toString('hex'), Date.now() + 60_000);
  let hostTasks = true;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    if (/\/features\/v[23]$/.test(String(url))) return new Response('', { status: 404 });
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
  expect(await identity.features(mcpUrl)).toEqual({ hostTasks: false, search: false, observability: false });
  await expect(new HostScriptAdminClient(mcpUrl, setup.token).scripts()).rejects.toThrow('turned off');
  expect(await identity.setFeatures(mcpUrl, { hostTasks: true })).toEqual({ hostTasks: true, search: false, observability: false });
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
