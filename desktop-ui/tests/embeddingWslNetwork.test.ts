import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, type NetworkInterfaceInfo } from 'node:os';
import { join } from 'node:path';
import { EmbeddingWslNetwork, wslAddresses } from '../src/main/embeddingWslNetwork';
import { embeddingHostSchema } from '../../control-plane/src/embeddingContract';

const directories: string[] = [];
const networks: EmbeddingWslNetwork[] = [];
afterEach(async () => {
  for (const network of networks.splice(0)) await network.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function ipv4(address: string): NetworkInterfaceInfo {
  return { address, family: 'IPv4', internal: false, netmask: '255.255.240.0', mac: '00:00:00:00:00:00', cidr: `${address}/20` };
}
it('selects only private IPv4 addresses on WSL virtual interfaces, never LAN/VPN/wildcard/public listeners', () => {
  expect(wslAddresses({
    'vEthernet (WSL)': [ipv4('172.24.32.1'), ipv4('0.0.0.0'), ipv4('8.8.8.8')],
    'vEthernet (WSL (Hyper-V firewall))': [ipv4('172.24.32.1'), ipv4('172.25.0.1')],
    Ethernet: [ipv4('192.168.1.2')], VPN: [ipv4('10.2.0.1')],
    'vEthernet (Default Switch)': [ipv4('172.26.0.1')],
  })).toEqual(['172.24.32.1', '172.25.0.1']);
});
it('accepts private WSL endpoint IPs only on the fixed inference port', () => {
  const token = 'a'.repeat(64);
  expect(embeddingHostSchema.parse({ endpoint: 'http://172.24.32.1:7716', token }).endpoint).toContain('172.24.32.1');
  for (const endpoint of ['http://8.8.8.8:7716', 'http://0.0.0.0:7716', 'http://172.24.32.1:80',
    'http://remote.example:7716', 'http://user:password@172.24.32.1:7716']) {
    expect(() => embeddingHostSchema.parse({ endpoint, token })).toThrow();
  }
});
it('retains explicit discovery failures and persists enablement for subsequent background discovery', async () => {
  const home = mkdtempSync(join(tmpdir(), 'wm-wsl-network-'));
  directories.push(home);
  const network = new EmbeddingWslNetwork(home, (_req, res) => res.end(), 7716, 'win32', () => []);
  networks.push(network);
  await network.configure(true);
  expect(network.error).toContain('No private IPv4');
  expect(network.endpoints).toEqual([]);
  await network.close();
  networks.pop();
  const restored = new EmbeddingWslNetwork(home, (_req, res) => res.end(), 7716, 'win32', () => []);
  networks.push(restored);
  expect(restored.enabled).toBe(true);
  await restored.configure(false);
  expect(restored.error).toBeNull();
});
