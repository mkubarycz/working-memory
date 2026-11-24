import { constants, createCipheriv, createHash, createPublicKey, publicEncrypt, randomBytes } from 'node:crypto';

export interface PublicFeedbackConfiguration {
  version: 1;
  uploadUrl: string;
  publicKey: string;
  deviceId?: string;
  deviceToken?: string;
}

export const MAX_PUBLIC_FEEDBACK_BYTES = 40 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function readFeedbackResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Feedback service returned an empty response.');
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 16_384) { await reader.cancel(); throw new Error('Feedback service response is too large.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Feedback service returned invalid JSON; no upload or connection is confirmed.'); }
}

export function validatePublicFeedbackConfiguration(input: unknown): PublicFeedbackConfiguration {
  if (!input || typeof input !== 'object' || !('version' in input) || input.version !== 1
    || !('uploadUrl' in input) || typeof input.uploadUrl !== 'string' || input.uploadUrl.length > 8192
    || !('publicKey' in input) || typeof input.publicKey !== 'string' || input.publicKey.length > 8192
    || !input.publicKey.startsWith('-----BEGIN PUBLIC KEY-----')) {
    throw new Error('The Feedback service returned invalid public configuration.');
  }
  let url: URL;
  try { url = new URL(input.uploadUrl); }
  catch { throw new Error('The public inbox upload URL is invalid.'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.search) {
    throw new Error('Feedback requires a credential-free HTTPS service URL.');
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
  return { envelope, url: url.href, deviceId: configuration.deviceId, deviceToken: configuration.deviceToken };
}

export async function uploadPublicFeedback(
  payload: { envelope: string; url: string; deviceId?: string; deviceToken?: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!payload.deviceId || !payload.deviceToken) throw new Error('Connect this computer in Settings > Feedback and ask the owner to approve it.');
  const url = new URL(payload.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid Feedback upload URL.');
  let response: Response;
  try {
    response = await fetcher(payload.url, {
      method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${payload.deviceToken}`, 'x-feedback-device': payload.deviceId },
      body: payload.envelope,
    });
  } catch {
    throw new Error('Public inbox upload could not be confirmed. Retry to check the same report without creating another submission.');
  }
  if (response.status === 201 || response.status === 200) {
    const receipt = await readFeedbackResponse(response);
    if (!receipt || typeof receipt !== 'object' || !('queued' in receipt) || receipt.queued !== true
      || !('requestId' in receipt) || receipt.requestId !== JSON.parse(payload.envelope).requestId) {
      throw new Error('Feedback returned an invalid upload confirmation. Retry the same report; nothing is confirmed queued.');
    }
    return;
  }
  if (response.status === 401 || response.status === 403) throw new Error('Feedback device is unapproved or revoked. Open Settings > Feedback to connect this computer.');
  throw new Error(`Feedback upload failed (HTTP ${response.status}). ${response.status === 429 ? 'Upload limit reached; wait before retrying.' : 'Retry the same report; nothing is confirmed queued.'}`);
}
