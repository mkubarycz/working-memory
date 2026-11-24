import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { maintenancePath, readInstanceMaintenance } from '../src/main/instanceMaintenance';
import { InstanceMonitor } from '../src/main/instanceMonitor';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../../scripts/with-instance-maintenance.mjs', import.meta.url));
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function healthEndpoint(health: () => { ok: boolean; bootId?: string }) {
  const server = createServer((_request, response) => {
    const result = health();
    response.statusCode = result.ok ? 200 : 503;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(result));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}/mcp`;
}

it('coordinates a real external command and health endpoint with restart monitoring, then detects a later restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wm-maintenance-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  let bootId = randomUUID();
  const mcpUrl = await healthEndpoint(() => ({ ok: true, bootId }));
  const probe = vi.fn(async () => ({ healthy: true, bootId, evidence: '', diagnostics: null }));
  const monitor = new InstanceMonitor({ file: join(directory, 'incidents.json'), selected: () => ({ mcpUrl }),
    probe, deliver: async () => randomUUID() });
  cleanup.push(() => monitor.stop());
  await monitor.tick();
  const command = execute(process.execPath, ['--experimental-strip-types', script, '--user-data', directory,
    '--mcp-url', mcpUrl, '--', process.execPath, '-e', 'setTimeout(()=>{},250)']);
  const records = join(directory, 'instance-maintenance');
  await vi.waitFor(() => expect(readInstanceMaintenance(records, mcpUrl)).not.toBeNull());
  bootId = randomUUID();
  await monitor.tick();
  expect(probe).toHaveBeenCalledOnce();
  await command;
  expect(readInstanceMaintenance(records, mcpUrl)?.bootId).toBe(bootId);
  await monitor.tick();
  expect(monitor.incidents(mcpUrl)).toHaveLength(0);
  bootId = randomUUID();
  await monitor.tick();
  expect(monitor.incidents(mcpUrl).map(incident => incident.kind)).toEqual(['restart']);
  expect(existsSync(`${maintenancePath(records, mcpUrl)}.lock`)).toBe(false);
});

it('expires maintenance immediately on command failure and refuses an unbounded deadline before executing', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wm-maintenance-failure-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const mcpUrl = await healthEndpoint(() => ({ ok: false }));
  const args = ['--experimental-strip-types', script, '--user-data', directory, '--mcp-url', mcpUrl];
  await expect(execute(process.execPath, [...args, '--seconds', '901', '--', process.execPath, '-e', 'process.exit(7)']))
    .rejects.toThrow('deadline of 1');
  const records = join(directory, 'instance-maintenance');
  expect(readInstanceMaintenance(records, mcpUrl)).toBeNull();
  await expect(execute(process.execPath, [...args, '--', process.execPath, '-e', 'process.exit(7)']))
    .rejects.toThrow('Deployment exited with code 7');
  const record = readInstanceMaintenance(records, mcpUrl);
  expect(record?.expiresAt).toBeLessThanOrEqual(Date.now());
  expect(record?.bootId).toBeUndefined();
  expect(existsSync(`${maintenancePath(records, mcpUrl)}.lock`)).toBe(false);
});

it('retains the command failure while accepting only a health-verified recovery boot', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wm-maintenance-recovery-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  const bootId = randomUUID();
  const mcpUrl = await healthEndpoint(() => ({ ok: true, bootId }));
  await expect(execute(process.execPath, ['--experimental-strip-types', script, '--user-data', directory,
    '--mcp-url', mcpUrl, '--', process.execPath, '-e', 'process.exit(7)'])).rejects.toThrow('Deployment exited with code 7');
  expect(readInstanceMaintenance(join(directory, 'instance-maintenance'), mcpUrl)).toMatchObject({
    bootId, completedAt: expect.any(Number),
  });
});
