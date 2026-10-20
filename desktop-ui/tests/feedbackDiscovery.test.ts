import { describe, expect, it } from 'vitest';
import { createSocket } from 'node:dgram';
import { discoverFeedbackServers, feedbackBroadcastTargets } from '../src/main/feedbackDiscovery';

describe('Feedback discovery', () => {
  it('includes a local probe and only deduplicated IPv4 broadcast addresses', () => {
    const targets = feedbackBroadcastTargets();
    expect(targets).toContain('127.0.0.1');
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets.every(target => /^\d+\.\d+\.\d+\.\d+$/.test(target))).toBe(true);
  });

  it('rejects unrelated responses and deduplicates matching certificates', async () => {
    const responder = createSocket('udp4');
    responder.on('message', (bytes, peer) => {
      const query = JSON.parse(bytes.toString());
      const reply = { type: 'wm-feedback-service', version: 1, nonce: query.nonce, port: 7720, name: 'Feedback', fingerprint: 'a'.repeat(64) };
      for (const packet of [null, {}, { ...reply, nonce: 'wrong' }, { ...reply, port: 80 }, { ...reply, fingerprint: 'invalid' }, reply, reply]) {
        responder.send(Buffer.from(JSON.stringify(packet)), peer.port, peer.address);
      }
    });
    await new Promise<void>(resolve => responder.bind(0, '127.0.0.1', resolve));
    try {
      const servers = await discoverFeedbackServers({ targets: ['127.0.0.1'], port: responder.address().port, timeoutMs: 40 });
      expect(servers).toEqual([{ id: `127.0.0.1:${'a'.repeat(64)}`, name: 'Feedback', url: 'https://127.0.0.1:7720/topics', fingerprint: 'a'.repeat(64) }]);
    } finally { responder.close(); }
  });

  it('returns no servers when the discovery deadline expires without a valid response', async () => {
    expect(await discoverFeedbackServers({ targets: [], timeoutMs: 5 })).toEqual([]);
  });
});
