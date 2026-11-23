import { constants, createDecipheriv, generateKeyPairSync, privateDecrypt } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { encryptPublicFeedback, uploadPublicFeedback, validatePublicFeedbackConfiguration } from '../../shared/publicFeedback';
import { PublicFeedbackConfigStore } from '../src/main/publicFeedbackConfig';
import { DesktopCredentialVault } from '../src/main/credentialVault';
import { FeedbackSender } from '../src/main/topicSharing';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const requestId = 'ed9cc832-401a-4fba-9fd0-33cb7b0f2d0c';
const configuration = {
  version: 1 as const,
  uploadUrl: 'https://wmfeedbacktest.blob.core.windows.net/reports?sp=c&sr=c&spr=https&se=2099-01-01T00%3A00%3A00Z&sig=private-upload-token',
  publicKey: keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
};

describe('public Feedback delivery', () => {
  it('encrypts the complete report for only the intended receiver and protects its identity against tampering', () => {
    const payload = encryptPublicFeedback('selected prompt and diagnostics', requestId, configuration);
    expect(payload.envelope).not.toContain('selected prompt');
    const envelope = JSON.parse(payload.envelope);
    const key = privateDecrypt({ key: keys.privateKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING },
      Buffer.from(envelope.key, 'base64'));
    const decrypt = (id: string) => {
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAAD(Buffer.from(`wm-feedback-inbox-v1:${id}:${envelope.recipient}`));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString();
    };
    expect(decrypt(requestId)).toBe('selected prompt and diagnostics');
    expect(() => decrypt('another-id')).toThrow();
    expect(payload.url).toBe(encryptPublicFeedback('selected prompt and diagnostics', requestId, configuration).url);
  });

  it('rejects broader SAS grants, expired credentials, private keys and untrusted destinations', () => {
    for (const url of [
      configuration.uploadUrl.replace('sp=c', 'sp=cw'),
      configuration.uploadUrl.replace('sp=c', 'sp=rc'),
      configuration.uploadUrl.replace('2099-', '2000-'),
      configuration.uploadUrl.replace('wmfeedbacktest.blob.core.windows.net', 'external.example'),
      configuration.uploadUrl.replace('spr=https', 'spr=https,http'),
    ]) expect(() => validatePublicFeedbackConfiguration({ ...configuration, uploadUrl: url })).toThrow();
    expect(() => validatePublicFeedbackConfiguration({ ...configuration,
      publicKey: keys.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() })).toThrow();
  });

  it('stores sender credentials encrypted and returns only a credential-free destination', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wm-public-feedback-'));
    try {
      const vault = new DesktopCredentialVault({ isEncryptionAvailable: () => false,
        encryptString: () => { throw new Error('No native storage'); }, decryptString: () => { throw new Error('No native storage'); } },
      'darwin', join(directory, 'vault.key'));
      const file = join(directory, 'public-feedback.json');
      const store = new PublicFeedbackConfigStore(file, vault);
      expect(await store.status()).toEqual({ enabled: false, destination: null });
      expect(await store.save(configuration)).toEqual({ enabled: true, destination: 'https://wmfeedbacktest.blob.core.windows.net/reports' });
      expect(await readFile(file, 'utf8')).not.toContain('private-upload-token');
      expect(await store.read()).toEqual(configuration);
      await store.clear();
      expect(await store.read()).toBeUndefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('reports queued rather than imported, retains retry identity, and never writes a fabricated receipt', async () => {
    const recordReceipt = vi.fn();
    const sender = new FeedbackSender(async () => ({
      topic: { title: 'Test report', body: 'Harmless test evidence' }, sourceUrl: 'http://127.0.0.1/mcp',
      context: { desktop: { version: 'fixture', build: 'fixture' }, backend: { version: 'fixture' } }, recordReceipt,
    }), async () => configuration);
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('Network interruption')).mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const preview = await sender.prepare('topic', requestId);
      expect(preview.servers).toMatchObject([{ delivery: 'public-inbox' }]);
      expect(fetcher).not.toHaveBeenCalled();
      await expect(sender.send('topic', requestId, preview.servers[0].id)).rejects.toThrow('could not be confirmed');
      const result = await sender.send('topic', requestId, preview.servers[0].id);
      expect(result).toMatchObject({ status: 'queued', requestId });
      expect(result).not.toHaveProperty('receipt');
      expect(await sender.send('topic', requestId, preview.servers[0].id)).toEqual(result);
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls[0][0]).toBe(fetcher.mock.calls[1][0]);
      expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
      expect(fetcher.mock.calls[0][1].headers).toEqual(fetcher.mock.calls[1][1].headers);
      expect(recordReceipt).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it('accepts only confirmed uploads or exact Azure duplicate conditions', async () => {
    const payload = encryptPublicFeedback('evidence', requestId, configuration);
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 412, headers: { 'x-ms-error-code': 'ConditionNotMet' } }))
      .mockResolvedValueOnce(new Response(null, { status: 409, headers: { 'x-ms-error-code': 'ContainerBeingDeleted' } }));
    await uploadPublicFeedback(payload, fetcher);
    await expect(uploadPublicFeedback(payload, fetcher)).rejects.toThrow('HTTP 409');
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'PUT', redirect: 'error', headers: { 'if-none-match': '*' } });
  });
});
