import { createHash, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAX_BYTES = 40 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const NAME = /^([a-f0-9-]{36})-([a-f0-9]{64})\.json$/;
export const hash = value => createHash('sha256').update(value).digest('hex');
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const matches = (secret, digest) => typeof secret === 'string' && SECRET.test(secret)
  && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)
  && timingSafeEqual(Buffer.from(hash(secret), 'hex'), Buffer.from(digest, 'hex'));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function quota(holder, key, period, limit, amount, now) {
  const bucket = Math.floor(now / period);
  if (holder[key]?.bucket !== bucket) holder[key] = { bucket, used: 0 };
  if (holder[key].used + amount > limit) fail(429, 'Rate limit reached. Retry later.');
  holder[key].used += amount;
}
function clean(state, now) {
  state.devices ??= {};
  for (const [id, device] of Object.entries(state.devices)) {
    if (device.state === 'pending' && device.expires <= now || device.state === 'revoked' && device.updated < now - 30 * 86400_000) delete state.devices[id];
  }
}
export function approve(state, code, now = Date.now()) {
  if (!/^[A-F0-9]{12}$/.test(code)) throw new Error('Use the 12-character pairing code shown on the device.');
  const device = Object.values(state.devices ?? {}).find(item => item.code === code && item.state === 'pending' && item.expires > now);
  if (!device) throw new Error('No live pending device has that code.');
  device.state = 'connected';
  device.updated = now;
  delete device.code;
  return { id: device.id, name: device.name, state: device.state };
}
export function revoke(state, id, now = Date.now()) {
  if (!UUID.test(id) || !state.devices?.[id]) throw new Error('Device not found.');
  const device = state.devices[id];
  device.state = 'revoked';
  device.updated = now;
  delete device.code;
  return { id: device.id, name: device.name, state: device.state };
}
export function publicConfiguration(publicKey, baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw new Error('FEEDBACK_PUBLIC_URL must be a clean HTTPS URL ending in /api.');
  if (url.pathname !== '/api') throw new Error('FEEDBACK_PUBLIC_URL must end in /api.');
  const key = createPublicKey(publicKey);
  if (!publicKey.startsWith('-----BEGIN PUBLIC KEY-----') || key.asymmetricKeyType !== 'rsa'
    || key.asymmetricKeyDetails.modulusLength < 2048 || key.asymmetricKeyDetails.modulusLength > 8192) throw new Error('Invalid receiver RSA public key.');
  return { version: 1, uploadUrl: `${url.href}/reports`, publicKey: key.export({ type: 'spki', format: 'pem' }).toString() };
}
function validateEnvelope(text, name, configuration) {
  const match = NAME.exec(name);
  if (!match || !UUID.test(match[1])) fail(400, 'Invalid report name.');
  let envelope;
  try { envelope = JSON.parse(text); } catch { fail(400, 'Invalid encrypted envelope.'); }
  const key = createPublicKey(configuration.publicKey);
  const recipient = hash(key.export({ type: 'spki', format: 'der' }));
  if (!record(envelope) || Object.keys(envelope).sort().join(',') !== 'data,iv,key,recipient,requestId,tag,version'
    || envelope.version !== 1 || envelope.requestId !== match[1] || envelope.recipient !== recipient) fail(400, 'Invalid encrypted envelope identity.');
  for (const [field, length] of [['iv', 12], ['tag', 16], ['key', key.asymmetricKeyDetails.modulusLength / 8], ['data', null]]) {
    const value = envelope[field];
    if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail(400, 'Invalid encrypted envelope encoding.');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.toString('base64') !== value || length !== null && bytes.length !== length) fail(400, 'Invalid encrypted envelope length.');
    if (field === 'data' && bytes.length > 29 * 1024 * 1024) fail(413, 'Encrypted payload exceeds the receiver limit.');
  }
  return envelope.requestId;
}

// Storage mutations use optimistic concurrency across every Function instance.
export function createService(storage, configuration, now = Date.now) {
  return async function handle(request) {
    await storage.mutate(state => {
      clean(state, now());
      quota(state, 'requests', 60_000, 600, 1, now());
    });
    const { method, path } = request;
    if (method === 'GET' && path === 'configuration') return { status: 200, body: configuration };
    if (method === 'POST' && ['devices/register', 'devices/status', 'devices/disconnect'].includes(path)) {
      if (path === 'devices/register') await storage.mutate(state => quota(state, 'registrations', 3600_000, 20, 1, now()));
      const body = await request.json(2048);
      if (!record(body) || !UUID.test(body.id) || !SECRET.test(body.proof)) fail(400, 'Invalid device request.');
      const bodyKeys = Object.keys(body).sort().join(',');
      if (bodyKeys !== (path === 'devices/register' ? 'id,name,proof,token' : 'id,proof')) fail(400, 'Invalid device request fields.');
      const result = await storage.mutate(state => {
        clean(state, now());
        let device = state.devices[body.id];
        if (path === 'devices/register') {
          if (!SECRET.test(body.token) || typeof body.name !== 'string' || !body.name.trim()
            || body.name.length > 80 || /[\u0000-\u001f\u007f]/.test(body.name)) fail(400, 'Invalid device registration.');
          if (!device) {
            if (Object.keys(state.devices).length >= 200) fail(429, 'Device capacity reached. Contact the owner.');
            let code;
            do { code = randomBytes(6).toString('hex').toUpperCase(); } while (Object.values(state.devices).some(item => item.code === code));
            device = state.devices[body.id] = { id: body.id, name: body.name, tokenHash: hash(body.token), proofHash: hash(body.proof),
              code, expires: now() + 15 * 60_000, state: 'pending', updated: now() };
          } else if (!matches(body.token, device.tokenHash)) fail(409, 'Device registration conflict.');
        }
        if (!device) return { state: 'expired' };
        if (!matches(body.proof, device.proofHash)) fail(403, 'Invalid device proof.');
        quota(device, 'polls', 60_000, 20, 1, now());
        if (path === 'devices/disconnect') {
          revoke(state, body.id, now());
          return { state: 'revoked' };
        }
        return { state: device.state, ...(device.state === 'pending' ? { pairingCode: device.code, expiresAt: new Date(device.expires).toISOString() } : {}) };
      });
      return { status: 200, body: result };
    }
    if (method === 'PUT' && path.startsWith('reports/')) {
      const name = path.slice('reports/'.length);
      if (!NAME.test(name) || !UUID.test(NAME.exec(name)[1])) fail(400, 'Invalid report name.');
      if (!UUID.test(request.deviceId ?? '') || !SECRET.test(request.token ?? '')) fail(401, 'Device approval required.');
      const size = request.contentLength;
      if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_BYTES) fail(413, 'A bounded Content-Length is required (maximum 40 MiB).');
      await storage.mutate(state => {
        const device = state.devices[request.deviceId];
        if (!device || !matches(request.token, device.tokenHash) || device.state !== 'connected') fail(403, 'Device is unapproved or revoked.');
        quota(device, 'uploads', 86400_000, 20, 1, now());
        quota(device, 'bytes', 86400_000, 200 * 1024 * 1024, size, now());
        quota(state, 'uploads', 86400_000, 200, 1, now());
        quota(state, 'bytes', 86400_000, 2 * 1024 * 1024 * 1024, size, now());
      });
      const text = await request.text(MAX_BYTES);
      if (Buffer.byteLength(text) !== size) fail(400, 'Content length mismatch.');
      const id = validateEnvelope(text, name, configuration);
      const digest = hash(text);
      // The receiver requires the plaintext digest in the filename. A separate immutable
      // claim binds request identity to ciphertext so a conflicting retry cannot succeed.
      const claim = JSON.stringify({ deviceId: request.deviceId, name, digest });
      if (!await storage.claim(id, claim)) fail(409, 'Request identity already belongs to different ciphertext.');
      const created = await storage.upload(name, text, digest);
      if (created === 'conflict') fail(409, 'Report name already belongs to different ciphertext.');
      return { status: created === 'created' ? 201 : 200, body: { queued: true, requestId: id } };
    }
    fail(404, 'Not found.');
  };
}
