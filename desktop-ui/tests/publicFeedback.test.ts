import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { encryptPublicFeedback, uploadPublicFeedback, validatePublicFeedbackConfiguration } from '../../shared/publicFeedback';
import { FEEDBACK_SERVICE, PublicFeedbackConfigStore } from '../src/main/publicFeedbackConfig';
import { DesktopCredentialVault } from '../src/main/credentialVault';
import { FeedbackSender } from '../src/main/topicSharing';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const requestId = 'ed9cc832-401a-4fba-9fd0-33cb7b0f2d0c';
const configuration = { version: 1 as const, uploadUrl: `${FEEDBACK_SERVICE}/reports`,
  publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  deviceId: requestId, deviceToken: 'd'.repeat(43) };
const context = { desktop: { version: 'fixture', build: 'fixture' }, backend: { version: 'fixture' } };
const response = (value: unknown) => new Response(JSON.stringify(value));
const pending = { state: 'pending', pairingCode: 'ABCDEF123456', expiresAt: '2099-01-01T00:00:00.000Z' };
function vault(directory: string) {
  return new DesktopCredentialVault({ isEncryptionAvailable: () => false,
    encryptString: () => { throw new Error('No native storage'); }, decryptString: () => { throw new Error('No native storage'); } },
  'darwin', join(directory, 'vault.key'));
}
describe('approved-device Feedback', () => {
  it('preserves receiver envelope encryption/AAD and plaintext-digest filename', () => {
    const payload = encryptPublicFeedback('private evidence', requestId, configuration);
    expect(payload.envelope).not.toContain('private evidence');
    const envelope = JSON.parse(payload.envelope);
    const key = privateDecrypt({ key: keys.privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(envelope.key, 'base64'));
    const decrypt = (id: string) => {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(`wm-feedback-inbox-v1:${id}:${envelope.recipient}`));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString();
    };
    expect(decrypt(requestId)).toBe('private evidence');
    expect(() => decrypt('different-id')).toThrow();
    expect(payload.url).toBe(encryptPublicFeedback('private evidence', requestId, configuration).url);
    expect(payload.url).toMatch(new RegExp(`${requestId}-[a-f0-9]{64}\\.json$`));
    for (const uploadUrl of ['http://example.test/reports', `${configuration.uploadUrl}?sig=secret`, 'https://user:password@example.test/reports']) {
      expect(() => validatePublicFeedbackConfiguration({ ...configuration, uploadUrl })).toThrow();
    }
  });
  it('persists protected pairing credentials before registration, exposes only public status and checks approval', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wm-feedback-device-'));
    try {
      const file = join(directory, 'device.json');
      let registration: Record<string, string> = {};
      let approved = false;
      const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
        expect(init?.redirect).toBe('error');
        expect(url).not.toMatch(/proof|token|sig=/);
        if (url.endsWith('devices/register')) {
          expect(await readFile(file, 'utf8')).not.toContain(JSON.parse(String(init?.body)).token);
          registration = JSON.parse(String(init?.body));
          return response(pending);
        }
        if (url.endsWith('devices/status')) return response(approved ? { state: 'connected' } : pending);
        if (url.endsWith('devices/disconnect')) return response({ state: 'revoked' });
        return response(configuration);
      });
      const store = new PublicFeedbackConfigStore(file, vault(directory), fetcher);
      expect((await store.status()).state).toBe('disconnected');
      expect((await store.connect()).state).toBe('pending');
      expect((await store.status()).pairingCode).toBe(pending.pairingCode);
      await expect(store.read()).rejects.toThrow('Connect this computer');
      approved = true;
      expect(await store.read()).toMatchObject({ deviceToken: registration.token, deviceId: registration.id });
      expect(JSON.stringify(await store.status())).not.toContain(registration.proof);
      expect(await readFile(file, 'utf8')).not.toContain(registration.token);
      await store.clear();
      expect((await store.status()).state).toBe('disconnected');
      await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('does not re-enable old SAS configuration or save credentials to insecure Linux storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wm-feedback-insecure-'));
    try {
      const encryptString = vi.fn((value: string) => Buffer.from(value));
      const insecure = new DesktopCredentialVault({ isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'basic_text', encryptString, decryptString: value => value.toString() },
      'linux', join(directory, 'vault.key'));
      const file = join(directory, 'device.json');
      await writeFile(file, JSON.stringify({ encryptedApiKey: 'legacy-SAS-configuration' }));
      const store = new PublicFeedbackConfigStore(file, insecure);
      expect((await store.status()).state).toBe('disconnected');
      await expect(store.read()).rejects.toThrow('Connect this computer');
      await expect(store.connect()).rejects.toThrow('OS-backed credential storage');
      expect(encryptString).not.toHaveBeenCalled();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('keeps approval/revocation/network errors explicit and refuses redirected configuration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wm-feedback-errors-'));
    try {
      const fetcher = vi.fn().mockResolvedValueOnce(response(pending)).mockResolvedValueOnce(response(pending))
        .mockResolvedValueOnce(response({ state: 'revoked' })).mockRejectedValueOnce(new Error('offline'));
      const store = new PublicFeedbackConfigStore(join(directory, 'device.json'), vault(directory), fetcher);
      await store.connect();
      expect((await store.status()).state).toBe('revoked');
      await expect(store.status()).rejects.toThrow('unreachable');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('retains identical ciphertext/request identity on uncertain retries, reports queued and never edits source', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const recordReceipt = vi.fn();
    const source = vi.fn(async () => ({ topic: { title: 'Report', body: 'Evidence' }, sourceUrl: 'http://127.0.0.1/mcp', context, recordReceipt }));
    const sender = new FeedbackSender(source, async () => configuration);
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('interrupted')).mockResolvedValueOnce(response({ queued: true, requestId }));
    vi.stubGlobal('fetch', fetcher);
    try {
      await sender.prepare('topic', requestId);
      expect(fetcher).not.toHaveBeenCalled();
      await expect(sender.send('topic', requestId)).rejects.toThrow('could not be confirmed');
      clock.mockReturnValue(1000 + 6 * 60_000);
      const result = await sender.send('topic', requestId);
      expect(result).toMatchObject({ status: 'queued', requestId });
      expect(await sender.send('topic', requestId)).toEqual(result);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
      expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
      expect(fetcher.mock.calls[0][1].headers).toEqual(fetcher.mock.calls[1][1].headers);
      expect(recordReceipt).not.toHaveBeenCalled();
      expect(source).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); vi.unstubAllGlobals(); }
  });
  it('expires only unattempted snapshots and treats rejected uploads as errors, not duplicate success', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      const sender = new FeedbackSender(async () => ({ topic: { title: 'Report', body: '' }, sourceUrl: '', context }), async () => configuration);
      await sender.prepare('topic', requestId);
      clock.mockReturnValue(1000 + 6 * 60_000);
      await expect(sender.send('topic', requestId)).rejects.toThrow('snapshot expired');
    } finally { clock.mockRestore(); }
    const payload = encryptPublicFeedback('evidence', requestId, configuration);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 409 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 })).mockResolvedValueOnce(new Response(null, { status: 429 }));
    await expect(uploadPublicFeedback(payload, fetcher)).rejects.toThrow('HTTP 409');
    await expect(uploadPublicFeedback(payload, fetcher)).rejects.toThrow('unapproved or revoked');
    await expect(uploadPublicFeedback(payload, fetcher)).rejects.toThrow('limit reached');
    await expect(uploadPublicFeedback(payload, vi.fn().mockResolvedValue(response({ queued: false, requestId })))).rejects.toThrow('invalid upload confirmation');
    await expect(uploadPublicFeedback(payload, vi.fn().mockResolvedValue(response({ queued: true, requestId: 'other' })))).rejects.toThrow('invalid upload confirmation');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'PUT', redirect: 'error',
      headers: { authorization: `Bearer ${configuration.deviceToken}`, 'x-feedback-device': requestId } });
  });
});
