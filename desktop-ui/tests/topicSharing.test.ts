import { describe, expect, it, vi } from 'vitest';
import { serializeFeedback, FeedbackSender } from '../src/main/topicSharing';

const requestId = 'ed9cc832-401a-4fba-9fd0-33cb7b0f2d0c';
const imageId = '503789c7-8f3a-439a-a8d9-680b50b993cd';
const context = { desktop: { version: '1.1.1', build: 'fixture' }, backend: { version: '2.0.7' } };
describe('encrypted feedback preparation', () => {
  it('serializes screenshots and version details without modifying source Markdown or source type', async () => {
    const topic = { title: 'Bug', body: `![Shot](wm-attachment:${imageId})`, topicType: 'foreign-type' };
    const fetcher = vi.fn().mockResolvedValue(new Response(Buffer.from('image'), { headers: { 'content-type': 'image/png' } }));
    const payload = JSON.parse(await serializeFeedback(topic, 'http://local/mcp', requestId, context, fetcher));
    expect(payload.requestId).toBe(requestId);
    expect(payload.topic).not.toHaveProperty('topicType');
    expect(payload.topic.body).toContain(topic.body);
    expect(payload.topic.body).toContain('Selected backend version: "2.0.7"');
    expect(payload.attachments[0].data).toBe(Buffer.from('image').toString('base64'));
    expect(topic.body).toBe(`![Shot](wm-attachment:${imageId})`);
  });
  it('rejects missing screenshots and oversized diagnostic bodies', async () => {
    await expect(serializeFeedback({ title: 'Bug', body: `![Shot](wm-attachment:${imageId})` },
      'http://local/mcp', requestId, context, vi.fn().mockResolvedValue(new Response('', { status: 404 })))).rejects.toThrow('nothing was shared');
    await expect(serializeFeedback({ title: 'Bug', body: 'x'.repeat(1_000_000) },
      'http://local/mcp', requestId, context)).rejects.toThrow('including version details');
  });
  it('never captures or sends through a fallback when this computer is unapproved', async () => {
    const source = vi.fn();
    const sender = new FeedbackSender(source, async () => { throw new Error('Connect this computer in Settings > Feedback'); });
    await expect(sender.send('report', requestId)).rejects.toThrow('Connect this computer');
    expect(source).not.toHaveBeenCalled();
  });
});
