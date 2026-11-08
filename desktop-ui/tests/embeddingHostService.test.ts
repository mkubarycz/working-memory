import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEmbeddingHostService, readEmbeddingHostSettings } from '../src/main/embeddingHostService';
import { embeddingServicePlist } from '../src/main/embeddingServiceManager';
import { EMBEDDING_MODEL, embeddingInferenceSchema, embeddingHostStatusSchema } from '../../control-plane/src/embeddingContract';
import { installEmbeddingModel } from '../src/main/embeddingRuntime';

vi.mock('../src/main/embeddingRuntime', () => ({
  installEmbeddingModel: vi.fn(async (_directory, _signal, progress) => progress(90871461)),
  EmbeddingRuntime: class {
    backend: string | null = null;
    warning = null;
    failure = null;
    rssBytes: number | null = null;
    async start() { this.backend = 'Core ML + CPU'; this.rssBytes = 1000; }
    async embed(texts: string[]) { return { id: 1, durationMs: 10, rssBytes: 1000,
      vectors: texts.map(() => Array.from({ length: 384 }, (_, index) => Number(index === 0))) }; }
    stop() { this.backend = null; this.rssBytes = null; }
  },
}));
const directories: string[] = [];
const servers: Awaited<ReturnType<typeof startEmbeddingHostService>>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  vi.useRealTimers();
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'wm-host-inference-'));
  directories.push(home);
  const token = 'b'.repeat(64);
  writeFileSync(join(home, 'host-token'), token);
  const server = await startEmbeddingHostService(home, '', 'test-version', 0);
  servers.push(server);
  return { home, server, url: `http://127.0.0.1:${server.port}`, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-WM-Embedding-Metrics': '1' } };
}
describe('independent host inference endpoint', () => {
  it('retains sanitized runtime failures in status, HTTP responses and the dashboard service log', async () => {
    const { home, url, headers } = await fixture();
    const token = 'b'.repeat(64);
    vi.mocked(installEmbeddingModel).mockRejectedValueOnce(new Error(`Embedding helper DLL missing. Bearer ${token}`));
    const response = await fetch(`${url}/embed`, { method: 'POST', headers,
      body: JSON.stringify({ model: EMBEDDING_MODEL, texts: ['Private authored passage.'] }) });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Embedding helper DLL missing. Bearer [redacted]' });
    expect(await (await fetch(`${url}/status`, { headers })).json()).toMatchObject({
      phase: 'error', backend: null, error: 'Embedding helper DLL missing. Bearer [redacted]',
    });
    const log = readFileSync(join(home, 'service.log'), 'utf8');
    expect(log).toContain('Embedding helper DLL missing');
    expect(log).not.toContain(token);
    expect(log).not.toContain('Private authored passage.');
  });
  it('keeps strict legacy response shapes unless the caller opts into metrics', async () => {
    const { url, headers } = await fixture();
    const legacy = { Authorization: headers.Authorization, 'Content-Type': 'application/json' };
    const result = await (await fetch(`${url}/embed`, { method: 'POST', headers: legacy,
      body: JSON.stringify({ model: EMBEDDING_MODEL, texts: ['nanites'] }) })).json();
    expect(() => embeddingInferenceSchema.omit({ startupMs: true }).parse(result)).not.toThrow();
    const status = await (await fetch(`${url}/status`, { headers: legacy })).json();
    expect(() => embeddingHostStatusSchema.omit({ idleTimeoutMinutes: true }).parse(status)).not.toThrow();
  });
  it('keeps the model warm by default, persists retention and unloads only after the configured idle period', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const { home, server, url, headers } = await fixture();
    const embed = () => fetch(`${url}/embed`, { method: 'POST', headers,
      body: JSON.stringify({ model: EMBEDDING_MODEL, texts: ['nanites'] }) }).then(response => response.json());
    expect((await embed()).startupMs).toBeGreaterThanOrEqual(0);
    await vi.advanceTimersByTimeAsync(70000);
    expect(await (await fetch(`${url}/status`, { headers })).json()).toMatchObject({ backend: 'Core ML + CPU', idleTimeoutMinutes: null });
    expect((await embed()).startupMs).toBe(0);
    expect((await fetch(`${url}/settings`, { method: 'PUT', headers, body: JSON.stringify({ idleTimeoutMinutes: -1 }) })).status).toBe(400);
    const saved = await fetch(`${url}/settings`, { method: 'PUT', headers, body: JSON.stringify({ idleTimeoutMinutes: 1 }) });
    expect(await saved.json()).toEqual({ idleTimeoutMinutes: 1 });
    expect(readEmbeddingHostSettings(home)).toEqual({ idleTimeoutMinutes: 1 });
    await vi.advanceTimersByTimeAsync(70000);
    expect(await (await fetch(`${url}/status`, { headers })).json()).toMatchObject({ backend: null, idleTimeoutMinutes: 1 });
    servers.splice(servers.indexOf(server), 1);
    await server.close();
    const restarted = await startEmbeddingHostService(home, '', 'test-version', 0);
    servers.push(restarted);
    expect(await (await fetch(`http://127.0.0.1:${restarted.port}/status`, { headers })).json()).toMatchObject({ idleTimeoutMinutes: 1 });
  });

  it('does not silently replace invalid persisted retention settings', async () => {
    const { home } = await fixture();
    writeFileSync(join(home, 'model-settings.json'), '{"idleTimeoutMinutes":"invalid"}');
    expect(() => readEmbeddingHostSettings(home)).toThrow();
    await expect(startEmbeddingHostService(home, '', 'test-version', 0)).rejects.toThrow();
  });

  it('requires authentication even for status and returns no credentials', async () => {
    const { url, headers } = await fixture();
    expect((await fetch(`${url}/status`)).status).toBe(401);
    const response = await fetch(`${url}/status`, { headers });
    expect(await response.json()).toMatchObject({ version: 'test-version', model: EMBEDDING_MODEL, backend: null });
  });
  it('accepts only bounded fixed-model inference and reports actual backend', async () => {
    const { url, headers } = await fixture();
    expect((await fetch(`${url}/embed`, { method: 'POST', headers, body: JSON.stringify({ model: 'other', texts: ['Network'] }) })).status).toBe(400);
    const result = await fetch(`${url}/embed`, { method: 'POST', headers,
      body: JSON.stringify({ model: EMBEDDING_MODEL, texts: ['Network recovery'] }) });
    expect(await result.json()).toMatchObject({ durationMs: 10, vectors: [expect.any(Array)] });
    const status = await (await fetch(`${url}/status`, { headers })).json();
    expect(status).toMatchObject({ phase: 'idle', backend: 'Core ML + CPU', rssBytes: 1000, downloadBytes: 90871461 });
    expect(JSON.stringify(status)).not.toContain('b'.repeat(64));
  });
  it('rejects command-shaped requests and oversized bodies', async () => {
    const { url, headers } = await fixture();
    expect((await fetch(`${url}/embed`, { method: 'POST', headers,
      body: JSON.stringify({ model: EMBEDDING_MODEL, texts: ['Network'], executable: '/tmp/other' }) })).status).toBe(400);
    expect((await fetch(`${url}/embed`, { method: 'POST', headers, body: 'x'.repeat(500001) })).status).toBe(413);
  });
  it('escapes startup paths and contains neither credentials nor a desktop launch', () => {
    const plist = embeddingServicePlist('/Applications/A&B.app/Contents/MacOS/Working Memory', '/Users/Example/A < B');
    expect(plist).toContain('A&amp;B.app');
    expect(plist).toContain('A &lt; B');
    expect(plist).toContain('--embedding-service');
    expect(plist).toContain('<key>KeepAlive</key><dict><key>PathState</key>');
    expect(plist).not.toContain('host-token');
    expect(embeddingServicePlist('/electron', '/profile', '/development/app'))
      .toContain('<string>/development/app</string>');
  });
});
