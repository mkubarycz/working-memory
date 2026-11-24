import type { Topic } from '../../../shared/controlPlaneClient';
import type { FeedbackContext, FeedbackPreparation, FeedbackSendResult } from '../shared/contracts';
import { encryptPublicFeedback, uploadPublicFeedback, type PublicFeedbackConfiguration } from '../../../shared/publicFeedback';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
type FeedbackTopic = Pick<Topic, 'title' | 'body'> & Partial<Pick<Topic, 'topicType'>>;

export async function serializeFeedback(
  topic: FeedbackTopic, sourceUrl: string, requestId: string, context: FeedbackContext, fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!UUID.test(requestId)) throw new Error('A valid sharing request ID is required.');
  const sharedBody = `${topic.body}\n\n---\n\n## Feedback environment\n\n`
    + `    Working Memory version: ${JSON.stringify(context.desktop.version)}\n`
    + `    Desktop build: ${JSON.stringify(context.desktop.build)}\n`
    + `    Selected backend version: ${JSON.stringify(context.backend.version)}\n`;
  const ids = [...new Set([...topic.body.matchAll(/wm-attachment:([a-z0-9-]+)/gi)].map(match => match[1].toLowerCase()))];
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
  const body = JSON.stringify({ version: 1, requestId, topic: { title: topic.title, body: sharedBody }, attachments });
  if (Buffer.byteLength(body) > 29 * 1024 * 1024) throw new Error('The shared topic exceeds the receiver payload limit.');
  return body;
}

interface FeedbackSnapshot {
  id: string;
  body: string;
  context: FeedbackContext;
  configuration: PublicFeedbackConfiguration;
  createdAt: number;
  payload?: ReturnType<typeof encryptPublicFeedback>;
  queued?: FeedbackSendResult;
}

export class FeedbackSender {
  private pending: Promise<FeedbackSnapshot> | undefined;
  private requestId = '';
  constructor(private readonly source: (id: string) => Promise<{
    topic: FeedbackTopic; sourceUrl: string; context: FeedbackContext; fetcher?: typeof fetch;
  }>, private readonly configuration: () => Promise<PublicFeedbackConfiguration>) {}

  private async snapshot(id: string, requestId: string): Promise<FeedbackSnapshot> {
    if (!UUID.test(requestId)) throw new Error('Invalid feedback request ID.');
    if (this.requestId !== requestId || !this.pending) {
      this.requestId = requestId;
      this.pending = (async () => {
        const configuration = await this.configuration();
        const { topic, sourceUrl, context, fetcher } = await this.source(id);
        return { id, body: await serializeFeedback(topic, sourceUrl, requestId, context, fetcher), context,
          configuration, createdAt: Date.now() };
      })();
    }
    let snapshot: FeedbackSnapshot;
    try { snapshot = await this.pending; }
    catch (error) { this.pending = undefined; throw error; }
    if (snapshot.id !== id) throw new Error('This feedback request belongs to a different topic.');
    if (!snapshot.payload && Date.now() - snapshot.createdAt > 5 * 60_000) throw new Error('Feedback snapshot expired. Close this dialog and try again.');
    return snapshot;
  }

  async prepare(id: string, requestId: string): Promise<FeedbackPreparation> {
    const snapshot = await this.snapshot(id, requestId);
    return { context: snapshot.context, destination: new URL(snapshot.configuration.uploadUrl).hostname };
  }

  async send(id: string, requestId: string): Promise<FeedbackSendResult> {
    const snapshot = await this.snapshot(id, requestId);
    if (!snapshot.queued) {
      snapshot.payload ??= encryptPublicFeedback(snapshot.body, requestId, snapshot.configuration);
      await uploadPublicFeedback(snapshot.payload);
      snapshot.queued = { status: 'queued', requestId, uploadedAt: new Date().toISOString(),
        destination: new URL(snapshot.configuration.uploadUrl).hostname };
    }
    return snapshot.queued;
  }
}
