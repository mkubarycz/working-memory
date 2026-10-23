import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { DataTierManager, dataTierInstanceNames } from '../src/main/dataTier';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it.each(['darwin', 'win32'] as const)('retrieves bootstrap through verified Docker ownership on %s, not host-specific token imports', async platform => {
  const directory = mkdtempSync(join(tmpdir(), 'wm-bootstrap-manager-'));
  directories.push(directory);
  writeFileSync(join(directory, 'instances.json'), JSON.stringify({ instances: [{
    port: 7719, name: 'Test', createdAt: '', image: 'working-memory-control-plane:1.2.0',
  }] }));
  const names = dataTierInstanceNames(7719);
  const mount = platform === 'win32'
    ? { Type: 'volume', Name: names.volume, Source: '/var/lib/docker/volumes/test', Destination: '/data' }
    : { Type: 'bind', Source: '/Users/test/Library/Application Support/WorkingMemory-7719', Destination: '/data' };
  const container = {
    Config: { Image: 'working-memory-control-plane:1.2.0', Labels: {
      'com.docker.compose.project': names.project, 'com.docker.compose.service': 'control-plane',
    } },
    Mounts: [mount], NetworkSettings: { Ports: { '7719/tcp': [{ HostIp: '127.0.0.1', HostPort: '7719' }] } },
  };
  const token = 't'.repeat(43);
  const run = vi.fn(async (_file: string, args: string[]) => {
    if (args[0] === 'info') return { stdout: '"1"', stderr: '' };
    if (args[0] === 'inspect') return { stdout: JSON.stringify([container]), stderr: '' };
    if (args[0] === 'exec') return { stdout: token, stderr: '' };
    throw new Error(`Unexpected Docker operation: ${args[0]}`);
  });
  const manager = new DataTierManager({
    platform, homedir: '/Users/test', env: { PATH: '/usr/bin', LOCALAPPDATA: '/unused' },
    buildContext: '/unused', stateDirectory: directory, version: '1.2.0',
    runner: { run }, fileExists: () => true,
  });
  expect(await manager.bootstrapCredential(7719)).toBe(token);
  expect(run.mock.calls.some(([, args]) => args[0] === 'exec' && args[1] === names.container)).toBe(true);
  container.NetworkSettings.Ports['7719/tcp'][0].HostIp = '0.0.0.0';
  run.mockClear();
  await expect(manager.bootstrapCredential(7719)).rejects.toThrow('does not match');
  expect(run.mock.calls.some(([, args]) => args[0] === 'exec')).toBe(false);
});
