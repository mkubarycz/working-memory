import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { TopicVM } from '../src/renderer/documents/types';
import { formatDocumentTimestamp } from '../src/renderer/documentDates';

let server: ViteDevServer;
let renderTopic: (topic: TopicVM, draft?: boolean) => string;

beforeAll(async () => {
  server = await createServer({
    configFile: false, root: new URL('..', import.meta.url).pathname,
    plugins: [svelte()], server: { middlewareMode: true }, appType: 'custom',
  });
  const { render } = await server.ssrLoadModule('svelte/server');
  const { default: TopicView } = await server.ssrLoadModule('/src/renderer/documents/TopicView.svelte');
  const noop = vi.fn();
  renderTopic = (topic, draft = false) => render(TopicView, { props: {
    topic, draft, saveState: 'idle', onSaveTopic: noop, onOpenTopic: noop,
    onOpenWorkstream: noop, onSetAgentMessageStatus: noop,
  } }).body;
});

afterAll(async () => { await server?.close(); });

describe('topic header rendering', () => {
  const topic: TopicVM = {
    kind: 'topic', id: '0e1e7544-6c42-4ca8-87e4-0819019240a2', title: 'A readable title',
    status: 'open', topicType: 'feature', typeMeta: null, body: '',
    createdAt: 1, updatedAt: 2, resourceVersion: 3, editable: true,
    parents: [], children: [], workstreams: [], focusedWorkstreams: [], agentMessages: [],
  };

  it.each([true, false])('keeps dates but omits the ID and leading separator (editable: %s)', (editable) => {
    const html = renderTopic({ ...topic, editable });
    const metadata = /<div class="head-meta[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
    expect(metadata).toBeDefined();
    expect(metadata).not.toContain(topic.id);
    const text = metadata!.replace(/<[^>]*>/g, '').trim();
    expect(text).toContain(`Created ${formatDocumentTimestamp(topic.createdAt)}`);
    expect(text).toContain(`Updated ${formatDocumentTimestamp(topic.updatedAt)}`);
    expect(text).toMatch(/^Created /);
    expect(text.match(/·/g)).toHaveLength(1);
    expect(html).toContain(topic.title);
  });

  it('continues hiding persisted metadata on a new topic draft', () => {
    expect(renderTopic(topic, true)).not.toContain('class="head-meta');
  });
});
