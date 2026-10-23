import { request } from 'node:https';
import { TLSSocket } from 'node:tls';
import type { ControlPlaneClient, Topic } from '../../../shared/controlPlaneClient';
import type { FeedbackContext, FeedbackPreparation, FeedbackSendResult, SharedTopicReceipt } from '../shared/contracts';
import { discoverFeedbackServers, type FeedbackDestination } from './feedbackDiscovery';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export async function serializeFeedback(
  topic: Pick<Topic, 'title' | 'body' | 'topicType'>,
  sourceUrl: string,
  requestId: string,
  context: FeedbackContext,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!UUID.test(requestId)) throw new Error('A valid sharing request ID is required.');
  const sharedBody = `${topic.body}\n\n---\n\n## Feedback environment\n\n`
    + `    Working Memory version: ${JSON.stringify(context.desktop.version)}\n`
    + `    Desktop build: ${JSON.stringify(context.desktop.build)}\n`
    + `    Selected backend version: ${JSON.stringify(context.backend.version)}\n`;
  const ids = [...new Set([...topic.body.matchAll(/wm-attachment:([a-z0-9-]+)/gi)].map((match) => match[1].toLowerCase()))];
  if (ids.length > 10 || sharedBody.length > 1_000_000) throw new Error('Sharing supports up to 10 images and a 1-million-character body, including version details.');
  const attachments: Array<{ id: string; filename: string; mimeType: string; data: string }> = [];
  let total = 0;
  for (const id of ids) {
    if (!UUID.test(id)) throw new Error(`Invalid attachment reference: ${id}`);
    const response = await fetcher(new URL(`/attachments/${id}`, sourceUrl), { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Unable to read screenshot ${id} (HTTP ${response.status}); nothing was shared.`);
    const mimeType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
    if (!IMAGE_TYPES[mimeType]) throw new Error(`Unsupported screenshot type: ${mimeType}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    total += bytes.length;
    if (!bytes.length || bytes.length > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) {
      throw new Error('Screenshots exceed the 10 MiB per-file or 20 MiB total sharing limit.');
    }
    attachments.push({ id, filename: `${id}.${IMAGE_TYPES[mimeType]}`, mimeType, data: bytes.toString('base64') });
  }
  const body = JSON.stringify({ version: 1, requestId, topic: { title: topic.title, body: sharedBody, topicType: topic.topicType }, attachments });
  if (Buffer.byteLength(body) > 29 * 1024 * 1024) throw new Error('The shared topic exceeds the receiver payload limit.');
  return body;
}

export function postFeedback(body: string, server: FeedbackDestination): Promise<SharedTopicReceipt> {
  const url = new URL(server.url);
  if (url.protocol !== 'https:' || url.pathname !== '/topics' || url.username || url.password || url.search || url.hash
    || !/^[0-9a-f]{64}$/.test(server.fingerprint)) throw new Error('Invalid discovered Feedback endpoint.');
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST', rejectUnauthorized: false, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 1024 * 1024) { req.destroy(new Error('Feedback receipt exceeds 1 MiB.')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(parseReceipt(res.statusCode ?? 0, JSON.parse(Buffer.concat(chunks).toString('utf8')), url)); }
        catch (error) { reject(error); }
      });
    });
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => {
        if (!(socket instanceof TLSSocket)
          || socket.getPeerCertificate().fingerprint256?.replaceAll(':', '').toLowerCase() !== server.fingerprint) {
          req.destroy(new Error('Feedback certificate changed since discovery; no content was sent.'));
          return;
        }
        req.end(body);
      });
    });
    req.setTimeout(120_000, () => req.destroy(new Error('Feedback delivery timed out. Retry in this dialog.')));
    req.on('error', reject);
  });
}

function parseReceipt(status: number, payload: unknown, receiverUrl: URL): SharedTopicReceipt {
  if (status < 200 || status >= 300) {
    const detail = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string' ? payload.error : `HTTP ${status}`;
    throw new Error(`Feedback failed: ${detail}`);
  }
  if (!payload || typeof payload !== 'object' || !('ok' in payload) || payload.ok !== true
    || !('topic' in payload) || !payload.topic || typeof payload.topic !== 'object'
    || !('id' in payload.topic) || typeof payload.topic.id !== 'string'
    || !('id' in payload.topic) || typeof payload.topic.id !== 'string'
    || !('title' in payload.topic) || typeof payload.topic.title !== 'string'
    || !UUID.test(payload.topic.id)
    || !('duplicate' in payload.topic) || typeof payload.topic.duplicate !== 'boolean'
    || !('statusUrl' in payload.topic) || typeof payload.topic.statusUrl !== 'string'
    || !('submittedAt' in payload.topic) || typeof payload.topic.submittedAt !== 'string'
    || !Number.isFinite(Date.parse(payload.topic.submittedAt))) {
    throw new Error('The Feedback server returned an invalid receipt; retry in this dialog.');
  }
  const statusUrl = new URL(payload.topic.statusUrl, receiverUrl);
  if (statusUrl.origin !== receiverUrl.origin || statusUrl.username || statusUrl.password || statusUrl.search || statusUrl.hash
    || statusUrl.pathname !== `/submissions/${payload.topic.id}`) {
    throw new Error('Feedback returned a status link outside its own API; retry in this dialog.');
  }
  return {
    id: payload.topic.id,  title: payload.topic.title, duplicate: payload.topic.duplicate,
    statusUrl: statusUrl.href, submittedAt: new Date(payload.topic.submittedAt).toISOString(),
  };
}

export async function recordFeedbackReceipt(
  client: Pick<ControlPlaneClient, 'getDocument' | 'updateDocument'>,
  sourceId: string,
  receipt: SharedTopicReceipt,
): Promise<void> {
  const current = await client.getDocument({ id: sourceId });
  if (!current.available || !current.document) throw new Error(current.error ?? 'The original topic is unavailable.');
  const document = current.document;
  if (document.kind !== 'Topic' || typeof document.spec.body !== 'string') throw new Error('The original topic has an invalid body.');
  if (document.spec.body.includes(`](${receipt.statusUrl})`)) return;
  const note = `Sent as feedback to Working Memory platform on ${receipt.submittedAt}. [Click to check status](${receipt.statusUrl})`;
  const result = await client.updateDocument({
    id: sourceId, expectedResourceVersion: document.metadata.resourceVersion,
    spec: { body: `${document.spec.body}\n\n${note}` },
  });
  if (!result.available || !result.document) throw new Error(result.error ?? 'The tracking note could not be saved.');
}

interface FeedbackSnapshot {
  id: string;
  body: string;
  context: FeedbackContext;
  servers: FeedbackDestination[];
  createdAt: number;
  receipt?: SharedTopicReceipt;
  recorded?: boolean;
  recordReceipt: (receipt: SharedTopicReceipt) => Promise<void>;
}

export class FeedbackSender {
  private pending: Promise<FeedbackSnapshot> | undefined;
  private requestId = '';
  constructor(private readonly source: (id: string) => Promise<{
    topic: Pick<Topic, 'title' | 'body' | 'topicType'>; sourceUrl: string; context: FeedbackContext;
    recordReceipt: (receipt: SharedTopicReceipt) => Promise<void>;
    fetcher?: typeof fetch;
  }>) {}

  private async snapshot(id: string, requestId: string): Promise<FeedbackSnapshot> {
    if (!UUID.test(requestId)) throw new Error('Invalid feedback request ID.');
    if (this.requestId !== requestId || !this.pending) {
      this.requestId = requestId;
      this.pending = (async () => {
        const { topic, sourceUrl, context, recordReceipt, fetcher } = await this.source(id);
        return { id, body: await serializeFeedback(topic, sourceUrl, requestId, context, fetcher), context, recordReceipt, servers: [], createdAt: Date.now() };
      })();
    }
    let snapshot: FeedbackSnapshot;
    try { snapshot = await this.pending; }
    catch (error) { this.pending = undefined; throw error; }
    if (snapshot.id !== id) throw new Error('This feedback request belongs to a different topic.');
    if (!snapshot.receipt && Date.now() - snapshot.createdAt > 5 * 60_000) throw new Error('Feedback snapshot expired. Close this dialog and try again.');
    return snapshot;
  }

  async prepare(id: string, requestId: string): Promise<FeedbackPreparation> {
    const snapshot = await this.snapshot(id, requestId);
    snapshot.servers = await discoverFeedbackServers();
    if (!snapshot.servers.length) throw new Error('No Feedback servers found. Start the Feedback container app; allow UDP 7721 and TCP 7720 on the same LAN.');
    return { context: snapshot.context, servers: snapshot.servers.map(({ id, name, url }) => ({ id, name, address: new URL(url).hostname })) };
  }

  async send(id: string, requestId: string, serverId?: string): Promise<FeedbackSendResult> {
    const snapshot = await this.snapshot(id, requestId);
    if (!snapshot.receipt) {
      if (!serverId) await this.prepare(id, requestId);
      const server = serverId ? snapshot.servers.find((candidate) => candidate.id === serverId)
        : snapshot.servers.length === 1 ? snapshot.servers[0] : undefined;
      if (serverId && !server) throw new Error('That Feedback server was not discovered for this request.');
      if (!server) return { status: 'choose', servers: snapshot.servers.map(({ id, name, url }) => ({ id, name, address: new URL(url).hostname })) };
      snapshot.receipt = await postFeedback(snapshot.body, server);
    }
    if (!snapshot.recorded) {
      try { await snapshot.recordReceipt(snapshot.receipt); }
      catch (error) {
        throw new Error(`Feedback was delivered, but its tracking note could not be saved. Click Send again to retry saving the note without resending. ${error instanceof Error ? error.message : String(error)}`);
      }
      snapshot.recorded = true;
    }
    return { status: 'sent', receipt: snapshot.receipt };
  }
}
