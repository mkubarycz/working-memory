import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { EmbeddingServiceManager } from '../src/main/embeddingServiceManager';
import { appendEmbeddingServiceLog, readEmbeddingServiceLog } from '../src/main/embeddingServiceLog';
import { EMBEDDING_MODEL, embeddingErrorMessage } from '../../control-plane/src/embeddingContract';

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: Object.assign(vi.fn(), { [promisify.custom]: mocks.execute }),
}));
const directories: string[] = [];
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'wm-embedding-diagnostics-'));
  directories.push(home);
  return { home, manager: new EmbeddingServiceManager('/installed/Working Memory', home, 'installed-build') };
}
describe('local embedding service troubleshooting', () => {
  it('reports the actual profile location and absence of a log or installed service', async () => {
    const { home, manager } = fixture();
    expect(await manager.diagnostics()).toMatchObject({
      logPath: join(home, 'service.log'), logExists: false, log: '',
      service: { state: 'not-installed', version: null },
    });
  });
  it('probes the host independently of MCP and never returns its credential', async () => {
    const { home, manager } = fixture();
    const token = 'a'.repeat(64);
    writeFileSync(join(home, 'host-token'), token);
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      model: EMBEDDING_MODEL, version: 'older-build', phase: 'error', downloadBytes: 0,
      backend: null, warning: null, rssBytes: null, error: `NPU plugin failed. Bearer ${token}`,
    })));
    vi.stubGlobal('fetch', fetch);
    const result = await manager.diagnostics();
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:7716/status', expect.objectContaining({
      headers: { Authorization: `Bearer ${token}` }, redirect: 'error',
    }));
    expect(result.service).toMatchObject({ state: 'running', version: 'older-build',
      expectedVersion: 'installed-build', phase: 'error', backend: null, error: 'NPU plugin failed. Bearer [redacted]' });
    expect(JSON.stringify(result)).not.toContain(token);
  });
  it('distinguishes connection failures from HTTP authorization and invalid status responses', async () => {
    const { home, manager } = fixture();
    writeFileSync(join(home, 'host-token'), 'a'.repeat(64));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    fetch.mockRejectedValueOnce(new Error('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:7716') }));
    expect((await manager.diagnostics()).service).toMatchObject({
      state: 'unreachable', error: expect.stringContaining('ECONNREFUSED'),
    });
    fetch.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect((await manager.diagnostics()).service.error).toContain('HTTP 401');
    fetch.mockResolvedValueOnce(new Response('{}'));
    expect((await manager.diagnostics()).service).toMatchObject({ state: 'unreachable', error: expect.any(String) });
  });
  it('records Windows task registration failures before a host service log exists', async () => {
    const { home, manager } = fixture();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connection refused'); }));
    mocks.execute.mockRejectedValueOnce(new Error('Scheduled Task registration denied'));
    await expect(manager.ensure()).rejects.toThrow('registration denied');
    expect(mocks.execute).toHaveBeenCalledWith('powershell.exe', expect.any(Array), expect.any(Object));
    expect(readEmbeddingServiceLog(home)).toMatchObject({
      logExists: true, log: expect.stringContaining('Desktop service setup failed: Scheduled Task registration denied'),
    });
    expect(readFileSync(join(home, 'service.log'), 'utf8')).toMatch(/^\d{4}-.*Desktop service setup failed/);
  });
  it('retains startup errors across manager recreation and bounds/redacts existing log tails', async () => {
    const { home } = fixture();
    appendEmbeddingServiceLog(home, 'Host service startup failed: missing helper DLL');
    const recreated = new EmbeddingServiceManager('/installed/Working Memory', home, 'installed-build');
    expect((await recreated.diagnostics()).log).toContain('missing helper DLL');
    const token = 'b'.repeat(64);
    writeFileSync(join(home, 'service.log'), Array.from({ length: 200 }, (_, index) =>
      `${index}: ${'x'.repeat(400)} token=${token} https://user:password@example.test/model`).join('\n'));
    const result = readEmbeddingServiceLog(home);
    expect(Buffer.byteLength(result.log)).toBeLessThanOrEqual(32768);
    expect(result.log.split('\n').length).toBeLessThanOrEqual(100);
    expect(result.log).toContain('199:');
    expect(result.log).not.toMatch(/^0: /m);
    expect(result.log).not.toContain(token);
    expect(result.log).not.toContain('user:password');
    writeFileSync(join(home, 'service.log'), 'x'.repeat(40000));
    expect(readEmbeddingServiceLog(home).log).toBe('[Log line exceeds the diagnostic limit.]');
  });
  it('preserves useful causes while bounding diagnostics and redacting credentials', () => {
    expect(embeddingErrorMessage(new Error('fetch failed', { cause: new Error('ECONNREFUSED') })))
      .toBe('fetch failed: ECONNREFUSED');
    const error = embeddingErrorMessage(`api_key="private-key" password=secret ${'x'.repeat(10000)}`);
    expect(error).toHaveLength(4000);
    expect(error).not.toContain('private-key');
    expect(error).not.toContain('secret');
  });
});
