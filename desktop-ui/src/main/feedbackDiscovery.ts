import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { randomUUID } from 'node:crypto';

export interface FeedbackDestination {
  id: string;
  name: string;
  url: string;
  fingerprint: string;
}

export function feedbackBroadcastTargets(): string[] {
  const targets = new Set(['127.0.0.1']);
  const number = (ip: string) => ip.split('.').reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0);
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.internal || entry.family !== 'IPv4' || entry.netmask === '255.255.255.255') continue;
      const broadcast = (number(entry.address) | ~number(entry.netmask)) >>> 0;
      targets.add([24, 16, 8, 0].map((shift) => (broadcast >>> shift) & 255).join('.'));
    }
  }
  return [...targets];
}

export function discoverFeedbackServers(options: { timeoutMs?: number; targets?: string[]; port?: number } = {}): Promise<FeedbackDestination[]> {
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    const nonce = randomUUID();
    const found = new Map<string, FeedbackDestination>();
    const errors: string[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let bound = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (bound) socket.close();
      else socket.unref();
      if (error) reject(error);
      else if (!found.size && errors.length) reject(new Error(`Feedback discovery failed: ${errors.join('; ')}`));
      else resolve([...found.values()]);
    };
    socket.once('error', finish);
    socket.on('message', (bytes, peer) => {
      if (bytes.length > 2048) return;
      let value: unknown;
      try { value = JSON.parse(bytes.toString('utf8')); }
      catch { return; }
      if (!value || typeof value !== 'object'
        || !('type' in value) || value.type !== 'wm-feedback-service'
        || !('version' in value) || value.version !== 1
        || !('nonce' in value) || value.nonce !== nonce
        || !('port' in value) || value.port !== 7720
        || !('name' in value) || typeof value.name !== 'string' || value.name.length > 100
        || !('fingerprint' in value) || typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint)) return;
      const url = `https://${peer.address}:7720/topics`;
      if (!found.has(value.fingerprint)) found.set(value.fingerprint, {
        id: `${peer.address}:${value.fingerprint}`, name: value.name, url, fingerprint: value.fingerprint,
      });
    });
    socket.bind(0, '0.0.0.0', () => {
      bound = true;
      socket.setBroadcast(true);
      const query = Buffer.from(JSON.stringify({ type: 'wm-feedback-discover', version: 1, nonce }));
      for (const address of options.targets ?? feedbackBroadcastTargets()) {
        socket.send(query, options.port ?? 7721, address, (error) => { if (error) errors.push(`${address}: ${error.message}`); });
      }
      timer = setTimeout(() => finish(), options.timeoutMs ?? 1_500);
    });
  });
}
