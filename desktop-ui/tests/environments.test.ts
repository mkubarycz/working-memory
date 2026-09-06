import { describe, expect, it, vi } from 'vitest';
import {
  DesktopEnvironmentManager,
  discoverDesktopEnvironments,
  parseLoopbackMcpUrl,
  type DesktopEnvironment,
  type EnvironmentClient,
} from '../src/main/environments';

const productionFile = '/Users/test/Library/Application Support/WorkingMemory/run/control-plane.port.json';
const sandboxFile = '/Users/test/wm-control-plane-sandbox/run/control-plane.port.json';

function discovery(files: Record<string, string>, healthyPorts: number[]) {
  return {
    platform: 'darwin' as const,
    env: {},
    homedir: '/Users/test',
    readTextFile: async (filePath: string) => {
      if (!(filePath in files)) throw new Error('missing');
      return files[filePath];
    },
    probe: async (environment: DesktopEnvironment) => healthyPorts.includes(environment.port),
  };
}

describe('desktop environment discovery', () => {
  it('discovers healthy known port files and prefers production ordering', async () => {
    const result = await discoverDesktopEnvironments(discovery({
      [productionFile]: JSON.stringify({ port: 7717, pid: 10 }),
      [sandboxFile]: JSON.stringify({ port: 8811, pid: 11 }),
    }, [7717, 8811]));
    expect(result.map(({ port, displayName, source }) => ({ port, displayName, source }))).toEqual([
      { port: 7717, displayName: '7717', source: 'production' },
      { port: 8811, displayName: '8811', source: 'sandbox' },
    ]);
  });

  it('rejects malformed, stale, dead, and duplicate candidates', async () => {
    const overrideFile = '/tmp/wm/run/control-plane.port.json';
    const readTextFile = vi.fn(async (filePath: string) => ({
      [productionFile]: JSON.stringify({ port: 7717, pid: 10 }),
      [overrideFile]: JSON.stringify({ port: 7717, pid: 10 }),
      [sandboxFile]: '{broken',
    }[filePath] ?? Promise.reject(new Error('missing'))));
    const probe = vi.fn(async () => false);
    const result = await discoverDesktopEnvironments({
      platform: 'darwin', env: { WM_CONTROL_PLANE_HOME: '/tmp/wm' }, homedir: '/Users/test', readTextFile, probe,
    });
    expect(result).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('includes a distinct healthy explicit home and rejects a wrong service probe', async () => {
    const overrideFile = '/tmp/wm/run/control-plane.port.json';
    const probe = vi.fn(async (environment: DesktopEnvironment) => environment.port !== 9900);
    const result = await discoverDesktopEnvironments({
      platform: 'darwin',
      env: { WM_CONTROL_PLANE_HOME: '/tmp/wm' },
      homedir: '/Users/test',
      readTextFile: async (filePath) => ({
        [productionFile]: JSON.stringify({ port: 7717, pid: 10 }),
        [overrideFile]: JSON.stringify({ port: 8811, pid: 11 }),
        [sandboxFile]: JSON.stringify({ port: 9900, pid: 12 }),
      }[filePath] ?? Promise.reject(new Error('missing'))),
      probe,
    });
    expect(result.map(({ port, source }) => ({ port, source }))).toEqual([
      { port: 7717, source: 'production' },
      { port: 8811, source: 'override' },
    ]);
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({ port: 9900 }));
  });

  it('accepts only fixed loopback MCP URLs', () => {
    expect(parseLoopbackMcpUrl('http://127.0.0.1:7717/mcp')?.port).toBe('7717');
    expect(parseLoopbackMcpUrl('http://localhost:7717/mcp')?.port).toBe('7717');
    expect(parseLoopbackMcpUrl('https://127.0.0.1:7717/mcp')).toBeNull();
    expect(parseLoopbackMcpUrl('http://192.168.1.20:7717/mcp')).toBeNull();
    expect(parseLoopbackMcpUrl('http://127.0.0.1:7717/health')).toBeNull();
  });
});

describe('desktop environment manager', () => {
  class FakeClient implements EnvironmentClient {
    readonly dispose = vi.fn(async () => {});
    readonly calls: string[] = [];
    constructor(readonly url: string) {}
    async listTools() { this.calls.push('listTools'); return []; }
    async callTool(name: string) { this.calls.push(`callTool:${name}`); return { ok: true, result: { ok: true } }; }
    async commandJournalCreate() { this.calls.push('journal:create'); }
  }

  function manager(selected: string | null = null) {
    const clients: FakeClient[] = [];
    const persisted: string[] = [];
    const instance = new DesktopEnvironmentManager<FakeClient>({
      ...discovery({
        [productionFile]: JSON.stringify({ port: 7717, pid: 10 }),
        [sandboxFile]: JSON.stringify({ port: 8811, pid: 11 }),
      }, [7717, 8811]),
      createClient: (url) => {
        const client = new FakeClient(url);
        clients.push(client);
        return client;
      },
      readPersistedSelection: async () => selected,
      writePersistedSelection: async (url) => { persisted.push(url); },
    });
    return { instance, clients, persisted };
  }

  it('restores a healthy persisted selection and falls back from a stale one', async () => {
    const restored = manager('http://127.0.0.1:8811/mcp');
    await restored.instance.initialize();
    expect(restored.instance.currentEnvironment?.port).toBe(8811);

    const fallback = manager('http://127.0.0.1:9999/mcp');
    await fallback.instance.initialize();
    expect(fallback.instance.currentEnvironment?.port).toBe(7717);
  });

  it('disposes the old session and routes subsequent access to the new client', async () => {
    const { instance, clients, persisted } = manager();
    await instance.initialize();
    const original = instance.currentClient;
    await original.commandJournalCreate();
    await instance.switchTo('http://127.0.0.1:8811/mcp');
    await instance.currentClient.commandJournalCreate();

    expect(original.dispose).toHaveBeenCalledOnce();
    expect(clients.map((client) => ({ url: client.url, calls: client.calls }))).toEqual([
      { url: 'http://127.0.0.1:7717/mcp', calls: ['journal:create'] },
      { url: 'http://127.0.0.1:8811/mcp', calls: ['journal:create'] },
    ]);
    expect(persisted).toEqual(['http://127.0.0.1:8811/mcp']);
  });
});

describe('desktop environment identity probe', () => {
  function identityClient(ping: { ok: boolean; result?: unknown }) {
    return {
      listTools: vi.fn(async () => [{ name: 'wm-ping' }, { name: 'wm-document-read' }]),
      callTool: vi.fn(async () => ping),
      dispose: vi.fn(async () => {}),
    } satisfies EnvironmentClient;
  }

  it('accepts a service only after wm-ping returns a Working Memory response', async () => {
    const client = identityClient({ ok: true, result: { ok: true, version: 'test' } });
    const result = await discoverDesktopEnvironments({
      platform: 'darwin', env: {}, homedir: '/Users/test',
      readTextFile: async (filePath) => filePath === productionFile
        ? JSON.stringify({ port: 7717, pid: 10 })
        : Promise.reject(new Error('missing')),
      createClient: () => client,
    });

    expect(result).toHaveLength(1);
    expect(client.callTool).toHaveBeenCalledWith('wm-ping', {});
    expect(client.dispose).toHaveBeenCalledOnce();
  });

  it.each([
    { ok: false, result: { ok: true } },
    { ok: true, result: { ok: true } },
    { ok: true, result: { ok: false } },
    { ok: true, result: { service: 'not-working-memory' } },
  ])('rejects advertised tools when wm-ping is not valid: %j', async (ping) => {
    const client = identityClient(ping);
    const result = await discoverDesktopEnvironments({
      platform: 'darwin', env: {}, homedir: '/Users/test',
      readTextFile: async (filePath) => filePath === productionFile
        ? JSON.stringify({ port: 7717, pid: 10 })
        : Promise.reject(new Error('missing')),
      createClient: () => client,
    });

    expect(result).toEqual([]);
    expect(client.callTool).toHaveBeenCalledWith('wm-ping', {});
    expect(client.dispose).toHaveBeenCalledOnce();
  });
});