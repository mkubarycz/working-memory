import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, type RunningServer } from '../../control-plane/src/server';
import { HostScriptAdminClient } from '../src/main/hostScriptClient';
import { executeHostScript, HOST_SCRIPT_EXAMPLE, hostScriptHostId } from '../src/main/hostScriptRunner';
import { registerHostScriptIpc } from '../src/main/hostScriptIpc';
import { scriptDefinitionSchema, scriptDefinitionHash, scriptJobSchema, type ScriptLease } from '../../control-plane/src/hostScriptPolicy';
import type { IpcMainInvokeEvent } from 'electron';
import { openStore, type Store } from '../../control-plane/src/store';
import { InstanceFeatureStore } from '../../control-plane/src/instanceFeatures';
import { DesktopInstanceIdentity } from '../src/main/instanceIdentity';
import { HostTaskCredentialVault } from '../src/main/hostTaskBroker';

const servers: RunningServer[] = [];
const stores: Store[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  stores.splice(0).forEach(store => store.close());
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
async function serverFixture() {
  const credential = randomBytes(32).toString('hex');
  const store = openStore(':memory:');
  stores.push(store);
  new InstanceFeatureStore(store.db).write({ hostTasks: true });
  const server = await startServer({ port: 0, store, hostTaskAdminCredential: credential });
  servers.push(server);
  return { server, credential, broker: new HostScriptAdminClient(`${server.url}/mcp`, credential) };
}

it('configures flags through trusted IPC while off and aborts an active runner when disabled', async () => {
  const { server, credential } = await serverFixture();
  const directory = await mkdtemp(join(tmpdir(), 'wm-host-feature-'));
  directories.push(directory);
  const vault = new HostTaskCredentialVault({
    isEncryptionAvailable: () => false, encryptString: vi.fn(), decryptString: vi.fn(),
  }, process.platform, directory);
  const identity = new DesktopInstanceIdentity(vault, async () => credential, () => true);
  const mcpUrl = `${server.url}/mcp`;
  const session = await identity.signIn(mcpUrl, 'private flag owner password', true);
  vault.setSession(server.url, session.token, session.expiresAt);
  await identity.setFeatures(mcpUrl, { hostTasks: false });
  const rendererUrl = 'file:///working-memory/renderer/index.html';
  const frame = { url: rendererUrl };
  const window = { webContents: { mainFrame: frame }, isDestroyed: () => false };
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  let executing!: () => void;
  const started = new Promise<void>(resolve => { executing = resolve; });
  let aborted = false;
  const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }), showOpenDialog: vi.fn(), showSaveDialog: vi.fn() };
  registerHostScriptIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    dialog, vault, identity, directory, getWindow: () => window,
    getEnvironment: () => ({ mcpUrl, displayName: 'Test' }), rendererUrl, platform: process.platform,
    execute: async (_lease: ScriptLease, signal?: AbortSignal) => new Promise<{ error: string }>(resolve => {
      signal?.addEventListener('abort', () => { aborted = true; resolve({ error: 'Stopped by flag' }); }, { once: true });
      executing();
    }),
  } as unknown as Parameters<typeof registerHostScriptIpc>[0]);
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!(event, ...args);
  expect(await call('instance:features')).toEqual({ hostTasks: false });
  expect(await call('host-scripts:get')).toMatchObject({ credentialReady: true, features: { hostTasks: false }, snapshot: null });
  const input = { name: '', description: '', parameters: {}, timeoutMs: 1000, example: true };
  await expect(call('host-scripts:register', input)).rejects.toThrow('turned off');
  expect(dialog.showMessageBox).not.toHaveBeenCalled();
  await call('instance:set-features', { hostTasks: true });
  const task = await call('host-scripts:register', input) as { id: string };
  await call('host-scripts:test', task.id, { name: 'Michael' });
  const next = call('host-scripts:next');
  const stopped = expect(next).rejects.toThrow('turned off');
  await started;
  await call('instance:set-features', { hostTasks: false });
  await stopped;
  expect(aborted).toBe(true);
  await expect(call('host-scripts:next')).rejects.toThrow('turned off');
}, 10000);
function lease(source = HOST_SCRIPT_EXAMPLE): ScriptLease {
  const definition = scriptDefinitionSchema.parse({
    name: 'Test', description: '', source, hostId: randomUUID(),
    parameters: { name: { type: 'string', required: true, maxLength: 80 } }, timeoutMs: 1000,
  });
  return { jobId: randomUUID(), leaseToken: randomBytes(32).toString('hex'), definition,
    definitionHash: scriptDefinitionHash(definition), parameters: { name: 'Michael' }, deadline: Date.now() + 10000 };
}

describe('real approved Node execution', () => {
  it('runs approved bytes with validated parameters in a child, without inherited application secrets', async () => {
    const result = await executeHostScript(lease());
    expect(JSON.parse(result.resultJson!)).toMatchObject({ greeting: 'Hello, Michael!', platform: process.platform });
    const original = process.env.WM_HOST_SCRIPT_TEST_SECRET;
    process.env.WM_HOST_SCRIPT_TEST_SECRET = 'never-inherit-this';
    try {
      const result = await executeHostScript(lease('module.exports = () => ({ value: process.env.WM_HOST_SCRIPT_TEST_SECRET ?? null });'));
      expect(result.resultJson).toBe('{"value":null}');
    } finally {
      if (original === undefined) delete process.env.WM_HOST_SCRIPT_TEST_SECRET;
      else process.env.WM_HOST_SCRIPT_TEST_SECRET = original;
    }
  });
  it('rejects modified code and invalid arguments before launching a process', async () => {
    const changed = lease();
    changed.definition.source += '\nthrow new Error("tampered");';
    await expect(executeHostScript(changed)).rejects.toThrow('bytes or parameter contract changed');
    await expect(executeHostScript({ ...lease(), parameters: { command: 'not allowed' } })).rejects.toThrow('Unknown parameter');
  });
  it.each([
    ['module.exports = () => { throw new Error("script failed"); };', 'script failed'],
    ['module.exports = () => undefined;', 'Return JSON data'],
    ['module.exports = () => "x".repeat(70000);', '64 KiB'],
    ['module.exports = () => require("./mutable-dependency");', 'built-in modules'],
    ['module.exports = {};', 'Export a function'],
  ])('returns an explicit bounded failure for %s', async (source, error) => {
    expect((await executeHostScript(lease(source))).error).toContain(error);
  });
  it('terminates synchronous loops and supports cancellation', async () => {
    await expect(executeHostScript(lease('module.exports = () => { while (true) {} };'))).rejects.toThrow('time limit');
    const controller = new AbortController();
    const running = executeHostScript(lease('module.exports = () => new Promise(() => {});'), controller.signal);
    setTimeout(() => controller.abort(), 50);
    await expect(running).rejects.toThrow('stopped');
  });
  it('rejects console floods instead of retaining unbounded logs', async () => {
    await expect(executeHostScript(lease('module.exports = () => { console.log("x".repeat(100000)); return {}; };')))
      .rejects.toThrow('console output');
  });
});

it('exposes only granted named MCP tools and completes a real authenticated request on the host', async () => {
  const { broker, server } = await serverFixture();
  const definition = lease().definition;
  const task = await broker.registerScript(definition);
  const app = await broker.createApp({ label: 'MCP caller', instanceId: randomUUID() });
  await broker.grantScript({ taskId: task.id, definitionHash: task.definitionHash, appId: app.appId, expiresAt: Date.now() + 60000 });
  const mcp = new Client({ name: 'host-script-test', version: '1' });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/host-tasks/v1/scripts/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${app.credential}` } },
    }));
    const tools = await mcp.listTools();
    expect(tools.tools.map(tool => tool.name)).toEqual([`host_script_${task.id.replaceAll('-', '')}`, 'host_script_job_read']);
    const response = await mcp.callTool({ name: tools.tools[0].name, arguments: { parameters: { name: 'Michael' }, idempotencyKey: 'mcp-one' } });
    expect(response.isError).not.toBe(true);
    const content = response.content;
    if (!Array.isArray(content) || content[0]?.type !== 'text') throw new Error('Expected JSON tool response');
    const job = scriptJobSchema.parse(JSON.parse(String(content[0].text)));
    const claimed = await broker.claimScript(definition.hostId);
    expect(claimed?.jobId).toBe(job.id);
    const result = await executeHostScript(claimed!);
    await broker.completeScript({ jobId: job.id, leaseToken: claimed!.leaseToken, ...result });
    const read = await mcp.callTool({ name: 'host_script_job_read', arguments: { id: job.id } });
    expect(JSON.stringify(read)).toContain('Hello, Michael!');
    await broker.revokeScript(task.id);
    expect((await mcp.listTools()).tools.map(tool => tool.name)).toEqual(['host_script_job_read']);
    const unauthorized = await fetch(`${server.url}/host-tasks/v1/admin/scripts`, {
      headers: { Authorization: `Bearer ${app.credential}` },
    });
    expect(unauthorized.status).toBe(401);
  } finally { await mcp.close(); }
}, 10000);

it('requires the trusted native frame and approval, then registers and runs the harmless example through IPC', async () => {
  const { server, credential } = await serverFixture();
  const directory = await mkdtemp(join(tmpdir(), 'wm-host-script-'));
  directories.push(directory);
  expect(await hostScriptHostId(directory)).toBe(await hostScriptHostId(directory));
  const rendererUrl = 'file:///working-memory/renderer/index.html';
  const frame = { url: rendererUrl };
  const window = { webContents: { mainFrame: frame }, isDestroyed: () => false };
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const vault = { read: vi.fn().mockResolvedValue(credential), import: vi.fn() };
  const dialog = { showMessageBox: vi.fn().mockResolvedValue({ response: 1 }), showOpenDialog: vi.fn(), showSaveDialog: vi.fn() };
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  registerHostScriptIpc({
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); } },
    dialog, vault, directory, getWindow: () => window,
    getEnvironment: () => ({ mcpUrl: `${server.url}/mcp`, displayName: 'Test' }),
    rendererUrl, platform: process.platform,
  } as unknown as Parameters<typeof registerHostScriptIpc>[0]);
  const call = async (channel: string, ...args: unknown[]) => handlers.get(`host-scripts:${channel}`)!(event, ...args);
  for (const handler of handlers.values()) {
    await expect(handler({ ...event, sender: {} } as IpcMainInvokeEvent)).rejects.toThrow('main frame');
  }
  expect(vault.read).not.toHaveBeenCalled();
  const input = { name: '', description: '', parameters: {}, timeoutMs: 1000, example: true };
  dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });
  expect(await call('register', input)).toBeUndefined();
  const task = await call('register', input) as { id: string };
  expect(task.id).toBeTruthy();
  expect(dialog.showMessageBox.mock.calls[1][1]).toMatchObject({ defaultId: 0, cancelId: 0 });
  expect(dialog.showMessageBox.mock.calls[1][1].detail).toContain('SHA-256');
  await expect(call('test', task.id, { name: 'Michael', command: 'not allowed' })).rejects.toThrow('Unknown parameter');
  await call('test', task.id, { name: 'Michael' });
  const completed = await call('next');
  expect(completed).toMatchObject({ state: 'succeeded' });
  expect(JSON.stringify(completed)).toContain('Hello, Michael!');
  expect(await call('next')).toBeNull();
}, 10000);
