import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { createServer, type Server } from 'node:https';
import { serializeFeedback, postFeedback, FeedbackSender, recordFeedbackReceipt } from '../src/main/topicSharing';
import { discoverFeedbackServers } from '../src/main/feedbackDiscovery';
import type { FeedbackDestination } from '../src/main/feedbackDiscovery';

vi.mock('../src/main/feedbackDiscovery', () => ({ discoverFeedbackServers: vi.fn() }));
const requestId = 'ed9cc832-401a-4fba-9fd0-33cb7b0f2d0c';
const imageId = '503789c7-8f3a-439a-a8d9-680b50b993cd';
const receipt = {
  id: requestId, slug: `shared-${requestId}`, title: 'A bug', duplicate: false,
  statusUrl: `/submissions/${requestId}`, submittedAt: '2026-10-20T19:52:00.000Z',
};
const recordReceipt = vi.fn(async () => {});
const received = (server: FeedbackDestination) => ({ ...receipt, statusUrl: new URL(receipt.statusUrl, server.url).href });
const context = { desktop: { version: '1.1.1', build: '2026-10-20T19:52:00.000Z' }, backend: { version: '2.0.7' } };
let directory: string;
let tls: { key: Buffer; cert: Buffer };
let fingerprint: string;
const servers: Server[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wm-feedback-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'key.pem'),
    '-out', join(directory, 'cert.pem'), '-days', '1', '-subj', '/CN=Feedback test'], { stdio: 'pipe' });
  tls = { key: await readFile(join(directory, 'key.pem')), cert: await readFile(join(directory, 'cert.pem')) };
  fingerprint = new X509Certificate(tls.cert).fingerprint256.replaceAll(':', '').toLowerCase();
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  await Promise.all(servers.splice(0).map((server) => { server.closeAllConnections(); return new Promise<void>((resolve) => server.close(() => resolve())); }));
});

async function receiver(onBody: (body: string) => void = () => {}): Promise<FeedbackDestination> {
  const server = createServer(tls, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      expect(req.headers.authorization).toBeUndefined();
      onBody(Buffer.concat(chunks).toString());
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, topic: receipt }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test socket address');
  return { id: 'local-feedback', name: 'Feedback', fingerprint, url: `https://127.0.0.1:${address.port}/topics` };
}

describe('automatic encrypted feedback', () => {
  it('serializes screenshot bytes and stable request identity without modifying source Markdown', async () => {
    const topic = { title: 'A bug', body: `![Shot](wm-attachment:${imageId})`, topicType: 'bug' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(Buffer.from('image'), { headers: { 'content-type': 'image/png' } })));
    const payload = JSON.parse(await serializeFeedback(topic, 'http://local:7717/mcp', requestId, context));
    expect(payload.requestId).toBe(requestId);
    expect(payload.topic).toMatchObject({ title: topic.title, topicType: topic.topicType });
    expect(payload.topic.body).toContain(topic.body);
    expect(payload.topic.body).toContain('Selected backend version: "2.0.7"');
    expect(payload.attachments[0].data).toBe(Buffer.from('image').toString('base64'));
    expect(topic.body).toBe(`![Shot](wm-attachment:${imageId})`);
  });

  it('rejects missing screenshots before any feedback submission', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(serializeFeedback({ title: 'Bug', body: `![Shot](wm-attachment:${imageId})`, topicType: 'bug' },
      'http://local/mcp', requestId, context)).rejects.toThrow('nothing was shared');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('accepts the discovered self-signed certificate without disabling normal TLS verification', async () => {
    const server = await receiver();
    await expect(fetch(server.url)).rejects.toThrow();
    expect(await postFeedback('{}', server)).toEqual(received(server));
    await expect(fetch(server.url)).rejects.toThrow();
  });

  it('checks the discovered fingerprint before transmitting any HTTP content', async () => {
    const body = vi.fn();
    const server = await receiver(body);
    await expect(postFeedback('private topic', { ...server, fingerprint: '0'.repeat(64) })).rejects.toThrow('no content was sent');
    expect(body).not.toHaveBeenCalled();
  });

  it('serializes before discovery and retries the same snapshot without credentials', async () => {
    let sentBody = '';
    const server = await receiver(body => { sentBody = body; });
    const topic = { title: 'A bug', body: 'Original', topicType: 'bug' };
    const source = vi.fn(async () => ({ topic, sourceUrl: 'http://local/mcp', context, recordReceipt }));
    vi.mocked(discoverFeedbackServers).mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      expect(source).toHaveBeenCalledTimes(1);
      return [server];
    });
    const sender = new FeedbackSender(source);
    await expect(sender.send('bug', requestId)).rejects.toThrow('No Feedback servers');
    topic.body = 'Changed after snapshot';
    expect(await sender.send('bug', requestId)).toEqual({ status: 'sent', receipt: received(server) });
    expect(JSON.parse(sentBody).topic.body).toContain('Original');
    expect(JSON.parse(sentBody).topic.body).not.toContain('Changed after snapshot');
    expect(JSON.parse(sentBody).requestId).toBe(requestId);
    expect(await sender.send('bug', requestId)).toEqual({ status: 'sent', receipt: received(server) });
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('asks for a selection instead of sending to an arbitrary server when several are discovered', async () => {
    const source = async () => ({ topic: { title: 'Bug', body: '', topicType: 'bug' }, sourceUrl: 'http://local/mcp', context, recordReceipt });
    const server = await receiver();
    vi.mocked(discoverFeedbackServers).mockResolvedValue([server, { ...server, id: 'other' }]);
    const sender = new FeedbackSender(source);
    expect(await sender.send('bug', requestId)).toMatchObject({ status: 'choose', servers: [{ id: 'local-feedback' }, { id: 'other' }] });
    await expect(sender.send('bug', requestId, 'not-discovered')).rejects.toThrow('not discovered');
    expect(await sender.send('bug', requestId, 'local-feedback')).toEqual({ status: 'sent', receipt: received(server) });
  });

  it('prepares a preview without transmitting content until Send and retains diagnostics on retries', async () => {
    const bodies: string[] = [];
    const server = await receiver(body => bodies.push(body));
    vi.mocked(discoverFeedbackServers).mockResolvedValue([server]);
    const topic = { title: 'Bug', body: 'Original source', topicType: 'bug' };
    const source = vi.fn(async () => ({ topic, sourceUrl: 'http://local/mcp', context, recordReceipt }));
    const sender = new FeedbackSender(source);
    const preview = await sender.prepare('bug', requestId);
    expect(preview.context).toEqual(context);
    expect(preview.servers).toHaveLength(1);
    expect(bodies).toHaveLength(0);
    expect(topic.body).toBe('Original source');
    await sender.send('bug', requestId, preview.servers[0].id);
    await sender.send('bug', requestId, preview.servers[0].id);
    expect(bodies).toHaveLength(1);
    expect(source).toHaveBeenCalledTimes(1);
    const sharedBody = JSON.parse(bodies[0]).topic.body;
    expect(sharedBody).toContain('Working Memory version: "1.1.1"');
    expect(sharedBody).toContain('Desktop build: "2026-10-20T19:52:00.000Z"');
    expect(sharedBody).toContain('Selected backend version: "2.0.7"');
  });

  it('includes diagnostic text in the receiver body limit', async () => {
    await expect(serializeFeedback({ title: 'Bug', body: 'x'.repeat(1_000_000), topicType: 'bug' },
      'http://local/mcp', requestId, context)).rejects.toThrow('including version details');
  });

  it('retries a failed source note without reposting delivered feedback', async () => {
    const bodies: string[] = [];
    const server = await receiver(body => bodies.push(body));
    vi.mocked(discoverFeedbackServers).mockResolvedValue([server]);
    const note = vi.fn().mockRejectedValueOnce(new Error('Version conflict')).mockResolvedValue(undefined);
    const sender = new FeedbackSender(async () => ({
      topic: { title: 'Bug', body: 'Source', topicType: 'bug' }, sourceUrl: 'http://local/mcp', context, recordReceipt: note,
    }));
    const preview = await sender.prepare('bug', requestId);
    await expect(sender.send('bug', requestId, preview.servers[0].id)).rejects.toThrow('Feedback was delivered');
    expect(bodies).toHaveLength(1);
    expect(await sender.send('bug', requestId, preview.servers[0].id)).toEqual({ status: 'sent', receipt: received(server) });
    await sender.send('bug', requestId, preview.servers[0].id);
    expect(bodies).toHaveLength(1);
    expect(note).toHaveBeenCalledTimes(2);
    expect(note).toHaveBeenLastCalledWith(received(server));
  });

  it('rejects a tracking link pointing away from the receiving API', async () => {
    const server = await receiver();
    const original = receipt.statusUrl;
    try {
      receipt.statusUrl = 'https://other.example/submissions/' + requestId;
      await expect(postFeedback('{}', server)).rejects.toThrow('outside its own API');
    } finally { receipt.statusUrl = original; }
  });
});

describe('source topic tracking note', () => {
  const document = {
    kind: 'Topic', metadata: { id: imageId, slug: 'source', resourceVersion: 42, labels: {}, createdAt: 1, updatedAt: 2, deletedAt: null },
    spec: { body: 'Latest authored edits', status: 'open' }, status: {},
  };
  const savedReceipt = { ...receipt, statusUrl: `https://192.168.0.175:7720${receipt.statusUrl}` };

  it('appends a dated link to the latest body using CAS and never patches status', async () => {
    const client = {
      getDocument: vi.fn(async () => ({ available: true, document })),
      updateDocument: vi.fn(async () => ({ available: true, document })),
    };
    await recordFeedbackReceipt(client, imageId, savedReceipt);
    expect(client.updateDocument).toHaveBeenCalledWith({
      id: imageId, expectedResourceVersion: 42, spec: {
        body: `Latest authored edits\n\nSent as feedback to Working Memory platform on ${receipt.submittedAt}. [Click to check status](${savedReceipt.statusUrl})`,
      },
    });
  });

  it('does not duplicate an existing tracking link', async () => {
    const client = {
      getDocument: vi.fn(async () => ({ available: true, document: { ...document, spec: { body: `Already sent [Click to check status](${savedReceipt.statusUrl})` } } })),
      updateDocument: vi.fn(async () => ({ available: true, document })),
    };
    await recordFeedbackReceipt(client, imageId, savedReceipt);
    expect(client.updateDocument).not.toHaveBeenCalled();
  });

  it('surfaces conflicts rather than overwriting concurrent authored edits', async () => {
    const client = {
      getDocument: vi.fn(async () => ({ available: true, document })),
      updateDocument: vi.fn(async () => ({ available: true, document: null, error: 'Version conflict' })),
    };
    await expect(recordFeedbackReceipt(client, imageId, savedReceipt)).rejects.toThrow('Version conflict');
  });
});
