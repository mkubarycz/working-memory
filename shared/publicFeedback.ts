import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';

export interface PublicFeedbackConfiguration {
  version: 1;
  uploadUrl: string;
  publicKey: string;
}

export const MAX_PUBLIC_FEEDBACK_BYTES = 40 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validatePublicFeedbackConfiguration(input: unknown): PublicFeedbackConfiguration {
  if (!input || typeof input !== 'object' || !('version' in input) || input.version !== 1
    || !('uploadUrl' in input) || typeof input.uploadUrl !== 'string' || input.uploadUrl.length > 8192
    || !('publicKey' in input) || typeof input.publicKey !== 'string' || input.publicKey.length > 8192
    || !input.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')) {
    throw new Error('Paste the public inbox sender configuration, including its upload URL and recipient public key.');
  }
  let url: URL;
  try { url = new URL(input.uploadUrl); }
  catch { throw new Error('The public inbox upload URL is invalid.'); }
  if (url.protocol !== 'https:' || !/^[a-z0-9]{3,24}\.blob\.core\.windows\.net$/.test(url.hostname)
    || url.port || url.username || url.password || url.hash || !/^\/[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\/?$/.test(url.pathname)
    || url.searchParams.get('sp') !== 'c' || url.searchParams.get('sr') !== 'c'
    || url.searchParams.get('spr') !== 'https' || !url.searchParams.get('sig')
    || !Number.isFinite(Date.parse(url.searchParams.get('se') ?? ''))
    || Date.parse(url.searchParams.get('se')!) <= Date.now()) {
    throw new Error('The public inbox needs an unexpired HTTPS Azure container SAS with create-only permission (c), not read, list, write or delete.');
  }
  let key: ReturnType<typeof createPublicKey>;
  try { key = createPublicKey(input.publicKey); }
  catch { throw new Error('The public inbox recipient public key is invalid.'); }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== 'rsa' || bits < 2048 || bits > 8192) {
    throw new Error('The public inbox recipient must use a 2048–8192-bit RSA public key.');
  }
  return { version: 1, uploadUrl: url.href, publicKey: key.export({ format: 'pem', type: 'spki' }).toString() };
}

export function publicFeedbackRecipient(publicKey: string): string {
  return createHash('sha256').update(createPublicKey(publicKey).export({ format: 'der', type: 'spki' })).digest('hex');
}

export function encryptPublicFeedback(body: string, requestId: string, configuration: PublicFeedbackConfiguration) {
  if (!UUID.test(requestId)) throw new Error('A valid feedback request ID is required.');
  const recipient = publicFeedbackRecipient(configuration.publicKey);
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`wm-feedback-inbox-v1:${requestId}:${recipient}`));
  const data = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
  const envelope = JSON.stringify({
    version: 1, requestId, recipient,
    key: publicEncrypt({ key: configuration.publicKey, oaepHash: 'sha256', padding: constants.RSA_PKCS1_OAEP_PADDING }, key).toString('base64'),
    iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64'),
  });
  if (Buffer.byteLength(envelope) > MAX_PUBLIC_FEEDBACK_BYTES) throw new Error('The encrypted feedback report exceeds 40 MiB.');
  const blobName = `${requestId.toLowerCase()}-${createHash('sha256').update(body).digest('hex')}.json`;
  const url = new URL(configuration.uploadUrl);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${blobName}`;
  return { envelope, url: url.href };
}

export async function uploadPublicFeedback(
  payload: { envelope: string; url: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(payload.url, {
      method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json', 'x-ms-blob-type': 'BlockBlob',
        'x-ms-version': '2023-11-03', 'if-none-match': '*' },
      body: payload.envelope,
    });
  } catch {
    throw new Error('Public inbox upload could not be confirmed. Retry to check the same report without creating another submission.');
  }
  if (response.status === 201 || response.status === 409 && response.headers.get('x-ms-error-code') === 'BlobAlreadyExists'
    || response.status === 412 && response.headers.get('x-ms-error-code') === 'ConditionNotMet') return;
  throw new Error(`Public inbox upload failed (HTTP ${response.status}). Check the sender configuration and SAS expiry, then retry.`);
}
