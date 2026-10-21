import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { Component } from 'svelte';
import type { ChatRun } from '../src/renderer/chatHistory';
import type { AgentMessageVM, TopicVM } from '../src/renderer/documents/types';

let server: ViteDevServer;
let render: typeof import('svelte/server').render;
let RecentMessages: Component<any>;
let ToolActivity: Component<any>;
let AgentMessageCard: Component<any>;
let MessageTimeline: Component<any>;
const context = { kind: 'topic', routeKind: 'topic', identifier: 'selected', title: 'Selected' };
const noop = vi.fn();

function run(index: number, overrides: Partial<ChatRun> = {}): ChatRun {
  return {
    key: `run-${index}`, journalId: `run-${index}`, startedAt: index, status: 'succeeded',
    userText: `Prompt ${index}`, assistantText: `Response ${index}`,
    scope: { kind: 'Topic', id: 'selected' }, entityRefs: [], attachments: [], tools: [],
    ...overrides,
  };
}

function props(runs: ChatRun[], extra = {}) {
  return {
    runs, context, humanName: 'Ada Lovelace', unreadResponses: [], onViewed: noop, onSetAgentMessageStatus: noop,
    onFocus: noop, onRetry: noop, runBlocked: () => false, onInspect: noop, onOpen: noop,
    attachmentUrl: (id: string) => `wm-attachment:${id}`, assistantFallback: (item: ChatRun) => item.status,
    onReload: noop, onResolve: noop, ...extra,
  };
}

beforeAll(async () => {
  server = await createServer({
    configFile: false, root: new URL('..', import.meta.url).pathname,
    plugins: [svelte()], server: { middlewareMode: true }, appType: 'custom',
  });
  ({ render } = await server.ssrLoadModule('svelte/server'));
  RecentMessages = (await server.ssrLoadModule('/src/renderer/RecentMessages.svelte')).default;
  ToolActivity = (await server.ssrLoadModule('/src/renderer/ToolActivity.svelte')).default;
  AgentMessageCard = (await server.ssrLoadModule('/src/renderer/documents/AgentMessageCard.svelte')).default;
  MessageTimeline = (await server.ssrLoadModule('/src/renderer/MessageTimeline.svelte')).default;
});

afterAll(async () => { await server?.close(); });

describe('rendered recent messages (Svelte server rendering, not browser layout)', () => {
  function message(index: number, extra: Partial<AgentMessageVM> = {}): AgentMessageVM {
    return { id: `canonical-${index}`, agentId: 'agent-1', agentName: 'Review Agent', title: `Canonical ${index}`, description: `Message body ${index}`,
      recommendedAction: '', category: 'completion', severity: 'info', status: 'open', attention: false,
      topics: ['selected'], relations: [], createdAt: (index + .5) / 1000, updatedAt: (index + .5) / 1000, ...extra };
  }

  it('collapses five recent rows plus older attention requests, each appearing once in chronological order', () => {
    const messages = [message(0, { attention: true, category: 'approval' }), message(4), message(7)];
    const html = render(RecentMessages, { props: props(Array.from({ length: 8 }, (_, i) => run(i)),
      { agentMessages: messages }) }).body;
    expect(html.match(/<details class="chat-run message-entry/g)).toHaveLength(6);
    expect(html).toContain('Canonical 7');
    expect(html).toContain('Needs your attention');
    expect(html).toContain('Canonical 0');
    expect(html).not.toContain('class="agent-message"');
    const timeline = html.slice(html.indexOf('id="scoped-messages"'));
    expect(timeline.match(/Canonical 0/g)).toHaveLength(1);
    expect(timeline.indexOf('Response 7')).toBeLessThan(timeline.indexOf('Canonical 7'));
  });

  it.each([false, true])('keeps attention cards within the shared message scroller when expanded=%s', (expanded) => {
    const html = render(RecentMessages, { props: props([run(2)], {
      expanded, agentMessages: [message(1, { attention: true, category: 'approval' })],
    }) }).body;
    const scroller = html.indexOf('<div class="scope-preview-history">');
    expect(scroller).toBeGreaterThan(-1);
    expect(html.indexOf('needs-attention')).toBeGreaterThan(scroller);
    expect(html).not.toContain('message-attention');
    expect(html.match(/data-agent-message-id="canonical-1"/g)).toHaveLength(expanded ? 2 : 1);
    expect(html.match(/class="agent-message(?:\s|")/g) ?? []).toHaveLength(expanded ? 1 : 0);
    expect(html.indexOf('id="scoped-messages"')).toBeGreaterThan(scroller);
    expect(html.match(/class="scope-preview-history"/g)).toHaveLength(1);
    expect(html.indexOf('class="scope-preview-heading"')).toBeLessThan(scroller);
  });

  it('keeps old trusted pending confirmations discoverable outside five newer canonical rows', () => {
    const pending = run(0, { status: 'awaiting_confirmation', userText: 'Protected write',
      pendingConfirmation: { id: 'protected', tool: 'ws-topic-update', arguments: { status: 'closed' } } });
    const messages = Array.from({ length: 8 }, (_, index) => message(index + 1));
    const html = render(RecentMessages, { props: props([pending], { agentMessages: messages }) }).body;
    expect(html.match(/<details class="chat-run message-entry/g)).toHaveLength(6);
    expect(html).toContain('awaiting confirmation');
    expect(html).toContain('Protected write');
    expect(html).toContain('aria-label="Expand message"');
    expect(html.match(/Protected write/g)).toHaveLength(1);
    expect(html).not.toContain('class="confirm"');
    expect(html).not.toContain('class="cancel"');
    const expanded = render(RecentMessages, { props: props([pending], { agentMessages: messages, expanded: true }) }).body;
    expect(expanded).toContain('class="confirm"');
    expect(expanded).toContain('class="cancel"');
  });

  it('expands canonical history with resolved/acknowledged rows, safe Markdown and explicit reopen, never execution controls', () => {
    const messages = [
      message(0, { status: 'resolved', description: '**History** <script>execute()</script>' }),
      message(1, { status: 'acknowledged' }), message(2, { category: 'approval', attention: true }),
    ];
    const html = render(RecentMessages, { props: props([run(3)], { agentMessages: messages, expanded: true }) }).body;
    expect(html).toContain('<strong>History</strong>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Reopen');
    expect(html).toContain('agent-message-entry');
    expect(html.match(/class="message-from"/g)).toHaveLength(3);
    expect(html.match(/>Review Agent</g)).toHaveLength(3);
    expect(html.match(/class="message-avatar assistant-avatar"[^>]*>RA</g)).toHaveLength(3);
    expect(html).toContain('acknowledged');
    expect(html).toContain('Response 3');
    const approval = render(AgentMessageCard, { props: { message: messages[2], onSetStatus: noop } }).body;
    expect(approval).toContain('Acknowledge');
    expect(approval).toContain('Resolve');
    expect(approval).not.toContain('class="confirm"');
    expect(approval).not.toContain('class="cancel"');
    expect(approval).toContain('working-memory://open/agent-message/canonical-2');
    const timestamp = render(AgentMessageCard, { props: {
      message: message(3, { createdAt: 1_792_540_000 }), onSetStatus: noop,
    } }).body;
    expect(timestamp).toContain(`datetime="${new Date(1_792_540_000_000).toISOString()}"`);
  });

  it('uses identical exchange markup in both surfaces with explicit scope, focus and stable-id options', () => {
    const runs = [run(1)];
    const shared = { ...props(runs), agentMessages: [], expanded: true };
    const log = render(MessageTimeline, { props: { ...shared, attachRunIds: true } }).body;
    const scoped = render(MessageTimeline, { props: {
      ...shared, scoped: true, showScope: false, showInLog: true,
    } }).body;
    for (const html of [log, scoped]) {
      expect(html).toContain('class="timeline-command"');
      expect(html).toContain('class="user-entry"');
      expect(html).toContain('class="assistant-entry"');
      expect(html).toContain('class="message-avatar human-avatar" title="Ada Lovelace" aria-hidden="true">AL</span>');
      expect(html).toContain('class="message-avatar assistant-avatar" title="Working Memory" aria-hidden="true">WM</span>');
      expect(html.indexOf('human-avatar')).toBeLessThan(html.indexOf('class="tool-activity"'));
      expect(html.indexOf('class="tool-activity"')).toBeLessThan(html.indexOf('assistant-avatar'));
      expect(html).toContain('aria-label="Collapse message"');
      expect(html).toContain('class="timeline-dot"');
    }
    expect(log).toContain('id="chat-run-run-1"');
    expect(scoped).not.toContain('id="chat-run-run-1"');
    expect(log).toContain('class="user-scope"');
    expect(scoped).not.toContain('class="user-scope"');
    expect(scoped).toContain('Show in Log');
    expect(log).not.toContain('Show in Log');
  });

  it('renders global attention messages once and collapses either kind to escaped text and status only', () => {
    const messages = [message(1, { attention: true, description: '<script>unsafe()</script>' })];
    const shared = { ...props([run(2)]), agentMessages: messages };
    const expanded = render(MessageTimeline, { props: shared }).body;
    expect(expanded.match(/class="agent-message(?:\s|")/g)).toHaveLength(1);
    expect(expanded).not.toContain('global-attention');
    const collapsed = render(MessageTimeline, { props: { ...shared, expanded: false } }).body;
    expect(collapsed.match(/aria-label="Expand message"/g)).toHaveLength(2);
    expect(collapsed).toContain('Response 2');
    expect(collapsed).toContain('succeeded');
    expect(collapsed).toContain('&lt;script>');
    expect(collapsed).not.toContain('<script>');
    expect(collapsed).not.toContain('class="timeline-details"');
    expect(collapsed.match(/class="timeline-dot"/g)).toHaveLength(2);
  });

  it.each(['selected-id', 'selected-slug'])('puts the topic-type context icon above initials for scope %s', (identifier) => {
    const document: TopicVM = {
      kind: 'topic', id: 'selected-id', slug: 'selected-slug', title: 'Selected',
      status: 'open', topicType: 'experiment', typeMeta: {
        slug: 'experiment', label: 'Experiment', icon: 'beaker', description: '',
      },
      body: '', createdAt: 1, updatedAt: 1, resourceVersion: 1, editable: true,
      parents: [], children: [], workstreams: [], focusedWorkstreams: [], agentMessages: [],
    };
    const html = render(MessageTimeline, { props: {
      ...props([run(1, { scope: { kind: 'Topic', id: identifier } })]),
      agentMessages: [], documents: [document],
    } }).body;
    expect(html).toContain('codicon codicon-beaker');
    expect(html.indexOf('class="user-scope"')).toBeLessThan(html.indexOf('class="user-entry"'));
    expect(html).not.toContain('codicon-link');
  });

  it('displays recorded approval decisions as escaped communication, never executable confirmation controls', () => {
    for (const outcome of ['approved', 'rejected'] as const) {
      const value = message(1, { category: 'approval', decision: {
        outcome, decided_by: '<img src=x onerror=execute()>', reason: '<script>execute()</script>',
        decided_at: 1_792_540_000,
      } });
      const html = render(AgentMessageCard, { props: { message: value, onSetStatus: noop } }).body;
      expect(html).toContain(`Recorded decision: ${outcome}`);
      expect(html).toContain('aria-label="Recorded approval decision"');
      expect(html).toContain('&lt;img');
      expect(html).toContain('&lt;script');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<img');
      expect(html).toContain(`datetime="${new Date(1_792_540_000_000).toISOString()}"`);
      expect(html).toContain('not authorization');
      expect(html).not.toContain('class="confirm"');
      expect(html).not.toContain('class="cancel"');
      const informational = render(AgentMessageCard, { props: {
        message: { ...value, category: 'completion' }, onSetStatus: noop,
      } }).body;
      expect(informational).not.toContain('Recorded decision:');
    }
  });

  it('offers explicit communication-only decision buttons solely for undecided nonresolved approval requests', () => {
    const html = render(AgentMessageCard, { props: {
      message: message(1, { category: 'approval' }), onSetStatus: noop, onRecordDecision: noop,
    } }).body;
    expect(html).toContain('Record approved');
    expect(html).toContain('Record rejected');
    expect(html).toContain('Recorded by');
    expect(html).toContain('Display name, not proof of identity');
    expect(html.match(/<button disabled/g)).toHaveLength(2);
    expect(html).toContain('not execution authorization');
    expect(html).not.toContain('class="confirm"');
    expect(html).not.toContain('class="cancel"');
    for (const value of [
      message(1, { category: 'completion' }),
      message(1, { category: 'approval', status: 'resolved' }),
      message(1, { category: 'approval', decision: { outcome: 'approved', decided_by: 'Human' } }),
    ]) {
      const restricted = render(AgentMessageCard, { props: {
        message: value, onSetStatus: noop, onRecordDecision: noop,
      } }).body;
      expect(restricted).not.toContain('Record approved');
      expect(restricted).not.toContain('Record rejected');
    }
  });

  it('renders exactly five compact scoped rows and a clear expansion prompt', () => {
    const runs = Array.from({ length: 9 }, (_, i) => run(i));
    runs.push(run(100, { scope: { kind: 'Topic', id: 'unrelated' } }));
    const html = render(RecentMessages, { props: props(runs) }).body;
    expect(html.match(/<details class="chat-run message-entry/g)).toHaveLength(5);
    expect(html.match(/message-entry latest"/g)).toHaveLength(1);
    expect(html).toContain('Response 8');
    expect(html).not.toContain('Response 3');
    expect(html).not.toContain('Response 100');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Expand for all messages and details');
  });

  it('renders every scoped exchange when expanded, with safe Markdown, attachments and no unrelated conversation', () => {
    const runs = Array.from({ length: 9 }, (_, i) => run(i));
    runs[0].assistantText = '**Old response** <script>alert(1)</script>';
    runs[0].attachments = [{ id: 'image', filename: 'image.png', mimeType: 'image/png' }];
    runs.push(run(100, { scope: { kind: 'Workstream', id: 'selected' } }));
    const html = render(RecentMessages, { props: props(runs, { expanded: true }) }).body;
    expect(html.match(/<details class="chat-run message-entry/g)).toHaveLength(9);
    expect(html).toContain('<strong>Old response</strong>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('alt="image.png"');
    expect(html).not.toContain('Prompt 100');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Show in Log');
  });

  it('renders fewer rows and makes no-context, loading, errors and retry explicit', () => {
    expect(render(RecentMessages, { props: props([run(1)]) }).body.match(/<details class="chat-run message-entry/g)).toHaveLength(1);
    const empty = render(RecentMessages, { props: props([run(1)], { context: undefined }) }).body;
    expect(empty).toContain('No document selected');
    expect(empty).not.toContain('Response 1');
    const loading = render(RecentMessages, { props: props([], { loading: true }) }).body;
    expect(loading).toContain('role="status"');
    expect(loading).not.toContain('No messages for this scope');
    const failed = render(RecentMessages, { props: props([], { error: 'offline' }) }).body;
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('Retry loading messages');
  });

  it('keeps confirmation actions outside collapsed tools and shows failed/cancelled/running states', () => {
    const pending = run(1, { status: 'awaiting_confirmation',
      pendingConfirmation: { id: 'approval', tool: 'ws-topic-update', arguments: { title: 'Review' } } });
    const html = render(RecentMessages, { props: props([
      pending, run(2, { status: 'failed', assistantText: undefined }), run(3, { status: 'cancelled' }),
      run(4, { status: 'running', assistantText: undefined }),
    ], { expanded: true }) }).body;
    expect(html).toContain('aria-label="Tool action confirmation"');
    expect(html).toContain('class="confirm"');
    expect(html).toContain('class="cancel"');
    expect(html.indexOf('class="confirm"')).toBeGreaterThan(html.indexOf('</details>'));
    expect(html).toContain('failed');
    expect(html).toContain('cancelled');
    expect(html).toContain('running');
    expect(html).toContain('class="retry-button"');
  });
});

describe('rendered shared tool disclosure', () => {
  function tools(item: ChatRun) {
    return render(ToolActivity, { props: { run: item, onInspect: noop, onOpen: noop } }).body;
  }

  it('uses native keyboard-accessible details/summary for zero, singular and live counts', () => {
    expect(tools(run(1))).toMatch(/<summary>.*?0 tool calls/s);
    const live = run(1, { status: 'running', tools: [{
      journalId: 'run-1', sequence: 1, toolName: 'ws-topic-read', mode: 'read', status: 'pending',
    }] });
    expect(tools(live)).toContain('1 tool call');
    expect(tools(live)).toContain('codicon codicon-tools');
    expect(tools(live)).toContain('1 pending');
    live.tools.push({ ...live.tools[0], sequence: 2, status: 'failure' });
    expect(tools(live)).toContain('2 tool calls');
    expect(tools(live)).toContain('1 failed');
    expect(tools(live)).toContain('<details class="tool-activity">');
    expect(tools(live)).toContain('aria-label="Inspect ws-topic-read"');
  });

  it('counts calls once, preserves useful outcomes, and exposes failures and cancellations without opening details', () => {
    const item = run(1, { tools: [{
      journalId: 'run-1', sequence: 1, toolName: 'ws-topic-update', mode: 'write', status: 'cancelled',
    }], progress: [{ name: 'ws-topic-update', status: 'cancelled', summary: 'User declined the write' }] });
    const html = tools(item);
    expect(html).toContain('1 tool call');
    expect(html).not.toContain('2 tool calls');
    expect(html).toContain('1 cancelled');
    expect(html).toContain('User declined the write');
    const staleTools = tools({ ...item, progress: [
      ...item.progress!, { name: 'read', status: 'failed', summary: 'Permission denied' },
    ] });
    expect(staleTools).toContain('2 tool calls');
    expect(staleTools).toContain('1 failed');
    expect(tools(run(2, { progress: [
      { name: 'read', status: 'completed', summary: 'Found the topic' },
      { name: 'write', status: 'failed', summary: 'Permission denied' },
    ] }))).toContain('2 tool calls');
  });
});
