import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createPublicKey, generateKeyPairSync, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { createService, approve, revoke, publicConfiguration, hash, MAX_BYTES } from '../src/service.js';
import { createBlobStorage } from '../src/storage.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const configuration = publicConfiguration(keys.publicKey.export({ format: 'pem', type: 'spki' }).toString(), 'https://feedback.example/api');
function fakeBlobs() {
  const blobs = new Map();
  let version = 0;
  const client = { getContainerClient: container => ({ getBlockBlobClient: name => {
    const key = `${container}/${name}`;
    const current = () => {
      if (!blobs.has(key)) throw Object.assign(new Error('Missing'), { statusCode: 404 });
      return blobs.get(key);
    };
    return {
      async download() {
        const value = current();
        return { etag: value.etag, readableStreamBody: (async function* () { yield Buffer.from(value.text); })() };
      },
      async downloadToBuffer() { return Buffer.from(current().text); },
      async getProperties() { return { metadata: current().metadata }; },
      async upload(text, length, options) {
        assert.equal(Buffer.byteLength(text), length);
        const old = blobs.get(key);
        if (options.conditions.ifNoneMatch && old || options.conditions.ifMatch && old?.etag !== options.conditions.ifMatch) {
          throw Object.assign(new Error('Precondition'), { statusCode: 412 });
        }
        blobs.set(key, { text, etag: `${++version}`, metadata: options.metadata });
      },
    };
  } }) };
  return { blobs, client };
}
function fixture() {
  const { client, blobs } = fakeBlobs();
  let clock = 1_800_000_000_000;
  const storage = createBlobStorage(client);
  const handle = createService(storage, configuration, () => clock);
  const device = { id: randomUUID(), proof: randomBytes(32).toString('base64url'), token: randomBytes(32).toString('base64url'), name: 'Test computer' };
  const post = (path, body = device) => handle({ method: 'POST', path: `devices/${path}`, json: async () => body });
  const identity = () => ({ id: device.id, proof: device.proof });
  async function connect() {
    const pending = await post('register');
    await storage.mutate(state => approve(state, pending.body.pairingCode, clock));
    return pending;
  }
  function report(body = 'Private authored report', requestId = randomUUID()) {
    const key = randomBytes(32), iv = randomBytes(12);
    const recipient = hash(createPublicKey(configuration.publicKey).export({ type: 'spki', format: 'der' }));
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`wm-feedback-inbox-v1:${requestId}:${recipient}`));
    const data = Buffer.concat([cipher.update(body, 'utf8'), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, requestId, recipient,
      key: publicEncrypt({ key: configuration.publicKey, oaepHash: 'sha256' }, key).toString('base64'),
      iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    const path = `reports/${requestId}-${hash(body)}.json`;
    return { path, envelope, requestId };
  }
  const put = (report, overrides = {}) => handle({ method: 'PUT', path: report.path,
    deviceId: device.id, token: device.token, contentLength: Buffer.byteLength(report.envelope), text: async () => report.envelope, ...overrides });
  return { storage, blobs, handle, device, post, identity, connect, report, put, advance: ms => { clock += ms; } };
}
const status = code => error => error.status === code;

test('public configuration has only receiver key and credential-free HTTPS service location', async () => {
  const f = fixture();
  const result = await f.handle({ method: 'GET', path: 'configuration' });
  assert.deepEqual(Object.keys(result.body).sort(), ['publicKey', 'uploadUrl', 'version']);
  assert.throws(() => publicConfiguration(configuration.publicKey, 'http://feedback.example/api'));
  assert.throws(() => publicConfiguration(configuration.publicKey, 'https://feedback.example/api?sig=secret'));
  assert.throws(() => publicConfiguration(keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'https://feedback.example/api'));
});

test('pairing requires separate polling proof and Azure-owner approval; secrets are hashed', async () => {
  const f = fixture();
  const pending = await f.post('register');
  assert.equal(pending.body.state, 'pending');
  assert.match(pending.body.pairingCode, /^[A-F0-9]{12}$/);
  const stored = [...f.blobs.values()].map(item => item.text).join('');
  assert(!stored.includes(f.device.token));
  assert(!stored.includes(f.device.proof));
  await assert.rejects(f.post('status', { ...f.identity(), proof: randomBytes(32).toString('base64url') }), status(403));
  await assert.rejects(f.put(f.report()), status(403));
  await assert.rejects(f.handle({ method: 'POST', path: 'devices/approve', json: async () => ({ code: pending.body.pairingCode }) }), status(404));
  await f.storage.mutate(state => approve(state, pending.body.pairingCode, 1_800_000_000_000));
  assert.equal((await f.post('status', f.identity())).body.state, 'connected');
  await assert.rejects(f.storage.mutate(state => approve(state, pending.body.pairingCode)), /No live pending/);
  assert.equal((await f.put(f.report())).status, 201);
  await f.storage.mutate(state => revoke(state, f.device.id, 1_800_000_000_000));
  assert.equal((await f.post('status', f.identity())).body.state, 'revoked');
  await assert.rejects(f.put(f.report()), status(403));
});

test('pairing codes expire, registration retries retain identity, disconnect revokes', async () => {
  const f = fixture();
  const first = await f.post('register');
  assert.equal((await f.post('register')).body.pairingCode, first.body.pairingCode);
  f.advance(16 * 60_000);
  await assert.rejects(f.storage.mutate(state => approve(state, first.body.pairingCode, 1_800_000_000_000 + 16 * 60_000)), /No live pending/);
  assert.equal((await f.post('status', f.identity())).body.state, 'expired');
  await f.connect();
  await f.post('disconnect', f.identity());
  await assert.rejects(f.put(f.report()), status(403));
});

test('exact encrypted retries queue once and mismatched ciphertext or request names never pass as duplicates', async () => {
  const f = fixture();
  await f.connect();
  const report = f.report();
  assert.equal((await f.put(report)).status, 201);
  assert.equal((await f.put(report)).status, 200);
  assert.equal([...f.blobs.keys()].filter(key => key.startsWith('reports/')).length, 1);
  assert(!f.blobs.get(`reports/${report.path.slice(8)}`).text.includes('Private authored report'));
  await assert.rejects(f.put(f.report('Private authored report', report.requestId)), status(409));
  await assert.rejects(f.put(f.report('Different report', report.requestId)), status(409));
  const blob = f.blobs.get(`reports/${report.path.slice(8)}`);
  blob.metadata = {};
  await assert.rejects(f.put(report), status(409));
  assert.equal(blob.text, report.envelope);
});

test('uncertain storage completion retains immutable ciphertext claim and permits exact retry', async () => {
  const f = fixture();
  await f.connect();
  const report = f.report();
  const original = f.storage.upload;
  let once = true;
  f.storage.upload = async (...args) => {
    const result = await original(...args);
    if (once) { once = false; throw new Error('Connection interrupted after commit'); }
    return result;
  };
  await assert.rejects(f.put(report), /Connection interrupted/);
  assert.equal((await f.put(report)).status, 200);
});

test('malformed/oversized and unauthenticated reports are rejected without accepting plaintext', async () => {
  const f = fixture();
  await f.connect();
  const report = f.report();
  let read = false;
  const text = async () => { read = true; return report.envelope; };
  await assert.rejects(f.put(report, { token: undefined, text }), status(401));
  await assert.rejects(f.put(report, { contentLength: MAX_BYTES + 1, text }), status(413));
  assert.equal(read, false);
  for (const path of ['reports/../escape.json', 'reports/name.json', `${report.path}?sig=bad`]) {
    await assert.rejects(f.put({ ...report, path }), status(400));
  }
  for (const change of [{ recipient: '0'.repeat(64) }, { iv: 'bad' }, { tag: 'YQ==' }, { key: 'YQ==' }, { data: '' }, { plaintext: 'secret' }]) {
    const envelope = JSON.stringify({ ...JSON.parse(report.envelope), ...change });
    await assert.rejects(f.put({ ...report, envelope }), status(400));
  }
  assert.equal([...f.blobs.keys()].filter(key => key.startsWith('reports/')).length, 0);
});

test('per-device byte/upload quotas, registration quota and concurrent CAS apply across instances', async () => {
  const f = fixture();
  await f.connect();
  for (let i = 0; i < 5; i++) await assert.rejects(f.put(f.report(), { contentLength: MAX_BYTES, text: async () => '' }), status(400));
  await assert.rejects(f.put(f.report()), status(429));
  f.advance(86400_000);
  for (let i = 0; i < 20; i++) await f.put(f.report());
  await assert.rejects(f.put(f.report()), status(429));
  const other = fixture();
  await Promise.all(Array.from({ length: 10 }, () => other.storage.mutate(state => { state.counter = (state.counter ?? 0) + 1; })));
  assert.equal(await other.storage.mutate(state => state.counter), 10);
  for (let i = 0; i < 20; i++) {
    await other.post('register', { ...other.device, id: randomUUID() });
  }
  await assert.rejects(other.post('register'), status(429));
});

test('enforces the exact 29 MiB receiver ciphertext limit, not just the larger HTTP cap', async () => {
  const f = fixture();
  await f.connect();
  const report = f.report();
  const fields = JSON.parse(report.envelope);
  const envelope = JSON.stringify({ ...fields, data: Buffer.alloc(29 * 1024 * 1024).toString('base64') });
  assert.equal((await f.put({ ...report, envelope })).status, 201);
  const tooLarge = JSON.stringify({ ...fields, data: Buffer.alloc(29 * 1024 * 1024 + 1).toString('base64') });
  assert(Buffer.byteLength(tooLarge) < MAX_BYTES);
  await assert.rejects(f.put({ ...report, envelope: tooLarge }), status(413));
});
