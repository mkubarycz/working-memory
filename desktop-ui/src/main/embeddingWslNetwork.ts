import { createServer, type RequestListener, type Server } from 'node:http';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { embeddingErrorMessage, isPrivateEmbeddingAddress } from '../../../control-plane/src/embeddingContract';
import { appendEmbeddingServiceLog } from './embeddingServiceLog';

export const embeddingNetworkSettingsSchema = z.object({ enabled: z.boolean() }).strict();
const endpoint = (address: string, port: number) => `http://${address.includes(':') ? `[${address}]` : address}:${port}`;
export function wslAddresses(interfaces: Record<string, NetworkInterfaceInfo[] | undefined> = networkInterfaces()): string[] {
  return [...new Set(Object.entries(interfaces).filter(([name]) => /^vEthernet \(WSL\b.*\)$/i.test(name))
    .flatMap(([, entries]) => (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal
      && isPrivateEmbeddingAddress(entry.address)).map(entry => entry.address)))].sort();
}

export class EmbeddingWslNetwork {
  enabled = false;
  error: string | null = null;
  private servers = new Map<string, Server>();
  private running: Promise<void> | undefined;
  private closed = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private home: string, private handler: RequestListener, private port: number,
    private platform: NodeJS.Platform = process.platform, private addresses: () => string[] = wslAddresses) {
    try {
      this.enabled = embeddingNetworkSettingsSchema.parse(JSON.parse(readFileSync(join(home, 'network-settings.json'), 'utf8'))).enabled;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    this.timer = setInterval(() => { void this.refresh(); }, 10000);
    this.timer.unref();
  }
  get endpoints(): string[] { return [...this.servers.keys()].map(address => endpoint(address, this.port)); }
  async configure(enabled: boolean): Promise<void> {
    if (enabled && this.platform !== 'win32') throw new Error('WSL inference networking is supported only on Windows.');
    await this.running;
    if (this.closed) throw new Error('The WSL inference listener has stopped.');
    const file = join(this.home, 'network-settings.json');
    writeFileSync(`${file}.tmp`, JSON.stringify({ enabled }), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    this.enabled = enabled;
    await this.refresh();
  }
  refresh(): Promise<void> {
    return this.running ??= this.synchronize().finally(() => { this.running = undefined; });
  }
  private async synchronize(): Promise<void> {
    try {
      const wanted = this.enabled && this.platform === 'win32' ? this.addresses() : [];
      for (const [address, server] of this.servers) {
        if (!wanted.includes(address)) {
          server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
          this.servers.delete(address);
        }
      }
      const failures: string[] = [];
      for (const address of wanted) {
        if (this.servers.has(address)) continue;
        try {
          const server = createServer(this.handler);
          server.requestTimeout = 30000;
          server.headersTimeout = 10000;
          await new Promise<void>((resolve, reject) => {
            const failed = (error: Error) => reject(error);
            server.once('error', failed);
            server.listen(this.port, address, () => { server.removeListener('error', failed); resolve(); });
          });
          this.servers.set(address, server);
          appendEmbeddingServiceLog(this.home, `Authenticated WSL inference endpoint ready: ${endpoint(address, this.port)}`);
        } catch (error) { failures.push(`${address}: ${embeddingErrorMessage(error)}`); }
      }
      if (this.enabled && !wanted.length) {
        throw new Error('No private IPv4 address was found on a Windows vEthernet (WSL) interface. Start the selected WSL machine and Retry; no LAN listener was opened.');
      }
      if (failures.length) throw new Error(`Some WSL listeners could not bind: ${failures.join('; ')}`);
      this.error = null;
    } catch (error) {
      const message = embeddingErrorMessage(error);
      if (this.error !== message) {
        try { appendEmbeddingServiceLog(this.home, `WSL inference networking failed: ${message}`); }
        catch (logError) { console.error('[embeddings] Network failure could not be logged:', logError); }
      }
      this.error = message;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.running;
    for (const server of this.servers.values()) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    this.servers.clear();
  }
}
