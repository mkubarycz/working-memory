import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { fileURLToPath } from 'node:url';
import { addSearchTopicToWorkstream, openSearchWorkstreams, readOnlySearchTools, requireSemanticSearchReady, searchByIntent, searchWithMatches, searchInstructions } from '../src/main/documentSearch';
import { createSearchViewState, searchContextForDocument, searchContextForSession, searchStateAfterTabChange } from '../src/renderer/documentSearch';
import { chatToolsWithFeatures, sanitizeForJournalWithMetadata, systemPromptForContext } from '../src/main/desktopChatAgent';
import { createModelConversation, type ParsedModelTurn } from '../src/main/modelTools';
import { documentTabIcon, documentTabKey, openDocumentTab, restoreLocalDocumentTab, searchDocument, serializeDocumentTabs } from '../src/renderer/documentTabs';
import { documentRefreshTarget } from '../src/renderer/documentChanges';
import { chatContextForDocument } from '../src/shared/contracts';
import type { DocumentEnvelope, Workstream } from '../../shared/controlPlaneClient';
import type { DocumentQueryResult, QueryDocument, SearchBlock } from '../../shared/documentSearch';

const hit = { id: 'topic-1', kind: 'Topic', title: 'OAuth sign-in', excerpt: 'Reliable identity handshakes.', score: 0.81, similarity: 0.81, resourceVersion: 4 };
const topic: DocumentEnvelope = { kind: 'Topic', metadata: { id: hit.id, labels: {}, createdAt: 1, updatedAt: 1, deletedAt: null, resourceVersion: 4 },
  spec: { title: hit.title, body: 'Untouched markdown', status: 'open', workstreams: ['existing'], parents: ['parent'], focusedWorkstreams: ['existing'] }, status: {} };
const ws = (id: string, status = 'progress'): Workstream => ({
  id, title: id, status, closure: null, opened_at: 1, updated_at: 1, closed_at: null, resourceVersion: 1,
});
const queryDoc = (id = hit.id, overrides: Partial<QueryDocument> = {}): QueryDocument => ({
  id, kind: 'Topic', title: hit.title, body: hit.excerpt, bodyLength: hit.excerpt.length, bodyOffset: 0, nextBodyOffset: null,
  status: 'open', workstreams: ['release'], parents: [], createdAt: 1, updatedAt: 1, resourceVersion: 4, ...overrides,
});
const queryResult = (documents = [queryDoc()], overrides: Partial<DocumentQueryResult> = {}): DocumentQueryResult => ({
  count: documents.length, total: documents.length, nextOffset: null, version: 4, documents, ...overrides,
});
const call = (id: string, name: string, args: Record<string, unknown>): ParsedModelTurn => ({
  text: '', calls: [{ id, name, arguments: args }],
  assistantMessage: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
});
const answer = (blocks: SearchBlock[]): ParsedModelTurn => ({ text: JSON.stringify({ blocks }), calls: [] });
function harness(turns: ParsedModelTurn[]) {
  let previous: ParsedModelTurn | undefined;
  return {
    conversation: createModelConversation({ mode: 'chat-completions', model: 'test', userMessage: 'test',
      systemPrompt: searchInstructions(), tools: readOnlySearchTools([
        { name: 'wm-document-query' }, { name: 'wm-semantic-search' }, { name: 'wm-document-search' }, { name: 'ws-topic-delete' },
      ]) }),
    turn: vi.fn(async () => {
      const next = turns.shift();
      if (next) previous = next;
      if (!previous) throw new Error('Unexpected extra model turn');
      return previous;
    }),
    callTool: vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ ok: true, result: queryResult() })),
    signal: new AbortController().signal,
  };
}

describe('agentic document search', () => {
  it('returns a single-word search locally without an AI turn or extra reads', async () => {
    const timings = { startupMs: 0, inferenceMs: 7, rankingMs: 80, hostMs: 10 };
    const dependencies = { ...harness([]), conversation: undefined, onResults: vi.fn(),
      prepareConversation: vi.fn(async (): Promise<ReturnType<typeof createModelConversation>> => { throw new Error('No AI profile'); }) };
    dependencies.callTool.mockResolvedValue({ ok: true, result: { count: 1, results: [hit], timings } });
    const response = await searchWithMatches('nanites', dependencies);
    expect(response.results[0].id).toBe(hit.id);
    expect(response.trace?.[0].timings).toEqual(timings);
    expect(dependencies.onResults).toHaveBeenCalledWith(response);
    expect(dependencies.turn).not.toHaveBeenCalled();
    expect(dependencies.prepareConversation).not.toHaveBeenCalled();
    expect(dependencies.callTool).toHaveBeenCalledOnce();
  });

  it('publishes matches before a pending AI turn and preserves timing on refinement failure', async () => {
    let reject!: (error: Error) => void;
    const dependencies = { ...harness([]), onResults: vi.fn(), onTrace: vi.fn() };
    dependencies.callTool.mockResolvedValue({ ok: true, result: { count: 1, results: [hit] } });
    dependencies.turn.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    const pending = searchWithMatches('model research', dependencies);
    const rejected = expect(pending).rejects.toThrow('Model unavailable');
    await vi.waitFor(() => expect(dependencies.turn).toHaveBeenCalledOnce());
    expect(dependencies.onResults).toHaveBeenCalledWith(expect.objectContaining({ results: [expect.objectContaining({ id: hit.id })] }));
    reject(new Error('Model unavailable'));
    await rejected;
    expect(dependencies.onTrace).toHaveBeenLastCalledWith(expect.objectContaining({
      stage: 'ai', status: 'error', durationMs: expect.any(Number), error: 'Model unavailable',
    }));
  });

  it('does not require AI to return a genuine empty term search', async () => {
    const dependencies = harness([]);
    dependencies.callTool.mockResolvedValue({ ok: true, result: { count: 0, results: [] } });
    expect((await searchWithMatches('unknownterm', dependencies)).results).toEqual([]);
    expect(dependencies.turn).not.toHaveBeenCalled();
  });

  it('treats capped term matches as normal results, not partial evidence or a tool failure', async () => {
    const dependencies = harness([]);
    dependencies.callTool.mockResolvedValue({ ok: true, result: { count: 1, results: [hit], limited: true } });
    const response = await searchWithMatches('health', dependencies);
    expect(response).toMatchObject({ limited: true, partial: false, results: [expect.objectContaining({ id: hit.id })] });
    expect(response.trace).toEqual([expect.objectContaining({ status: 'success' })]);
    expect(dependencies.turn).not.toHaveBeenCalled();
    expect(dependencies.callTool).toHaveBeenCalledOnce();
  });

  it('publishes results before AI configuration failure and cancels pending refinement without losing the publication', async () => {
    const controller = new AbortController();
    const dependencies = { ...harness([]), signal: controller.signal, onResults: vi.fn() };
    dependencies.callTool.mockResolvedValue({ ok: true, result: { count: 1, results: [hit] } });
    dependencies.turn.mockImplementation(() => new Promise(() => {}));
    const pending = searchWithMatches('model research', dependencies);
    const cancelled = expect(pending).rejects.toThrow('Search cancelled');
    await vi.waitFor(() => expect(dependencies.turn).toHaveBeenCalledOnce());
    controller.abort(new Error('Search cancelled'));
    await cancelled;
    expect(dependencies.onResults).toHaveBeenCalledOnce();
    const unconfigured = { ...harness([]), conversation: undefined, onResults: vi.fn(),
      prepareConversation: vi.fn(async (): Promise<ReturnType<typeof createModelConversation>> => { throw new Error('No AI profile'); }) };
    unconfigured.callTool.mockResolvedValue({ ok: true, result: { count: 1, results: [hit] } });
    await expect(searchWithMatches('model research', unconfigured)).rejects.toThrow('No AI profile');
    expect(unconfigured.onResults).toHaveBeenCalledOnce();
  });

  it.each(['transport', 'tool', 'malformed'] as const)('reports initial retrieval failures in read-only activity (%s)', async failure => {
    const dependencies = { ...harness([]), onTrace: vi.fn() };
    const message = 'Search timed out while starting the local embedding model.';
    if (failure === 'transport') dependencies.callTool.mockRejectedValue(new Error(message));
    else if (failure === 'tool') dependencies.callTool.mockResolvedValue({ ok: false, error: message });
    else dependencies.callTool.mockResolvedValue({ ok: true, result: { results: [] } });
    await expect(searchWithMatches('nanites', dependencies)).rejects.toThrow(failure === 'malformed' ? 'Malformed' : message);
    expect(dependencies.onTrace).toHaveBeenCalledOnce();
    expect(dependencies.onTrace).toHaveBeenCalledWith(expect.objectContaining({
      tool: 'wm-semantic-search', status: 'error', durationMs: expect.any(Number),
      arguments: expect.objectContaining({ literalQuery: 'nanites' }), error: expect.any(String),
    }));
    expect(dependencies.turn).not.toHaveBeenCalled();
  });

  it.each([23, 24])('keeps the 24-call total budget including initial retrieval (%s additional calls)', async count => {
    const calls = Array.from({ length: count }, (_, index) => ({
      id: `read-${index}`, name: 'wm-document-query', arguments: { id: hit.id },
    }));
    const dependencies = harness([
      { text: '', calls, assistantMessage: { role: 'assistant', content: null, tool_calls: calls.map(item => ({
        id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.arguments) },
      })) } },
      answer([{ type: 'list', items: [{ sourceId: hit.id, text: 'Supporting evidence.' }] }]),
    ]);
    dependencies.callTool.mockResolvedValueOnce({ ok: true, result: { count: 1, results: [hit] } });
    const pending = searchWithMatches('model research', dependencies);
    if (count === 23) {
      expect((await pending).trace?.filter(entry => entry.stage !== 'ai')).toHaveLength(24);
      expect(dependencies.callTool).toHaveBeenCalledTimes(24);
    } else {
      await expect(pending).rejects.toThrow('24 total; 1 used, 24 requested');
      expect(dependencies.callTool).toHaveBeenCalledTimes(1);
    }
  });

  it.each(['chat-completions', 'responses'] as const)('handles a batch of five evidence reads after initial retrieval and an empty literal query (%s)', async mode => {
    const hits = Array.from({ length: 4 }, (_, index) => ({ ...hit, id: `source-${index}` }));
    const calls = [
      ...hits.map(source => ({ id: `read-${source.id}`, name: 'wm-document-query', arguments: { id: source.id } })),
      { id: 'types', name: 'wm-document-query', arguments: { kind: 'TopicType' } },
    ];
    const dependencies = harness([
      call('literal', 'wm-document-query', { query: 'model research' }),
      { text: '', calls, assistantMessage: { role: 'assistant', content: null, tool_calls: calls.map(item => ({
        id: item.id, type: 'function', function: { name: item.name, arguments: JSON.stringify(item.arguments) },
      })) } },
      answer([{ type: 'list', items: hits.map(source => ({ sourceId: source.id, text: 'Supporting research.' })) }]),
    ]);
    dependencies.conversation = createModelConversation({ ...dependencies.conversation, mode });
    dependencies.callTool.mockImplementation(async (name, args) => name === 'wm-semantic-search'
      ? { ok: true, result: { count: hits.length, results: hits } }
      : { ok: true, result: queryResult(typeof args.id === 'string' ? [queryDoc(args.id)] : []) });
    const response = await searchWithMatches('model research', dependencies);
    expect(response.results.map(source => source.id)).toEqual(hits.map(source => source.id));
    expect(response.trace?.filter(entry => entry.stage !== 'ai')).toHaveLength(7);
    expect(response.trace?.filter(entry => entry.stage === 'ai')).toHaveLength(3);
    expect(response.trace?.every(entry => entry.status === 'success')).toBe(true);
    expect(dependencies.callTool).toHaveBeenCalledTimes(7);
    const outputs = mode === 'responses' ? dependencies.conversation.responseInput
      : dependencies.conversation.chatMessages?.filter(message => message.role === 'tool').slice(-5);
    expect(outputs).toHaveLength(5);
  });

  it.each(['chat-completions', 'responses'] as const)('retrieves a phrase before asking questions and retains scored term matches before suggestions (%s)', async mode => {
    const dependencies = harness([answer([{ type: 'clarification', text: 'You can narrow these matches.',
      suggestions: ['Find bank account setup', 'Find bank networking notes'] }])]);
    dependencies.conversation = createModelConversation({ ...dependencies.conversation, mode });
    const literal = { ...hit, title: 'Account setup', excerpt: 'Configure the bank account.', literalMatch: true,
      similarity: 0.1, score: 0.1, confidence: { level: 'high' as const, reason: 'Exact word match.' } };
    dependencies.callTool.mockResolvedValue({ ok: true, result: { count: 1, results: [literal] } });
    const response = await searchWithMatches('bank account', dependencies);
    expect(dependencies.callTool).toHaveBeenCalledWith('wm-semantic-search', expect.objectContaining({ queries: ['bank account'], literalQuery: 'bank account' }));
    expect(response.blocks?.map(block => block.type)).toEqual(['list', 'clarification']);
    expect(response.results[0]).toMatchObject({ literalMatch: true, similarity: 0.1, confidence: { level: 'high' } });
    expect(JSON.stringify(mode === 'responses' ? dependencies.conversation.responseInput : dependencies.conversation.chatMessages)).toContain('Host-retrieved search evidence');
    expect(response.trace?.[0].tool).toBe('wm-semantic-search');
  });

  it('orders literal results before semantic-only model selections without dropping either', async () => {
    const other = { ...hit, id: 'semantic', score: 0.95, similarity: 0.95 };
    const dependencies = harness([answer([{ type: 'list', items: [{ sourceId: other.id, text: 'A related concept.' }] }])]);
    dependencies.callTool.mockResolvedValue({ ok: true, result: { count: 2, results: [
      { ...hit, literalMatch: true, similarity: 0.1, score: 0.1 }, other,
    ] } });
    const response = await searchWithMatches('bank account', dependencies);
    expect(response.results.map(result => result.id)).toEqual([hit.id, other.id]);
    expect(response.blocks?.[0]).toMatchObject({ type: 'list', items: [{ sourceId: hit.id }] });
  });

  it('does not ask the model when initial retrieval fails or the request is cancelled', async () => {
    const dependencies = harness([]);
    dependencies.callTool.mockRejectedValue(new Error('Backend unavailable'));
    await expect(searchWithMatches('bank', dependencies)).rejects.toThrow('Backend unavailable');
    expect(dependencies.turn).not.toHaveBeenCalled();
    const controller = new AbortController();
    controller.abort();
    dependencies.signal = controller.signal;
    dependencies.callTool.mockClear();
    await expect(searchWithMatches('bank', dependencies)).rejects.toThrow();
    expect(dependencies.callTool).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false, ready: false, pending: 0, error: 'Enable Embeddings' },
    { enabled: true, ready: false, pending: 2, error: '2 documents pending' },
  ])('does not invoke a model or retrieval while the semantic index is unavailable (%j)', async state => {
    const client = { callTool: vi.fn(async () => ({ ok: true, result: {
      enabled: state.enabled, ready: state.ready,
      stats: { total: 2, indexed: 2 - state.pending, pending: state.pending, limited: 0, vectorBytes: 0, lastIndexedAt: null },
    } })) };
    const dependencies = { ...harness([]), assertEnabled: () => requireSemanticSearchReady(client) };
    await expect(searchByIntent('Find a related subject', dependencies)).rejects.toThrow(state.error);
    if (state.enabled) await expect(requireSemanticSearchReady(client)).rejects.toThrow('Observability; enable Observability in Settings > Features');
    expect(dependencies.turn).not.toHaveBeenCalled();
    expect(dependencies.callTool).not.toHaveBeenCalled();
    expect(client.callTool).toHaveBeenCalledWith('wm-semantic-status', {}, undefined);
  });

  it('preserves semantic relevance and the supporting passage when reading additional source evidence', async () => {
    const dependencies = harness([
      call('discover', 'wm-semantic-search', { queries: ['Trouble signing in'] }),
      call('read', 'wm-document-query', { id: hit.id }),
      answer([{ type: 'list', items: [{ sourceId: hit.id, text: 'Describes the authentication handshake.' }] }]),
    ]);
    const confidence = { level: 'high' as const, reason: 'Strong passage and document evidence agree.' };
    dependencies.callTool.mockResolvedValueOnce({ ok: true, result: { count: 1, results: [{ ...hit, confidence, literalMatch: true }], limited: true } })
      .mockResolvedValueOnce({ ok: true, result: queryResult([queryDoc(hit.id, { body: 'Full source evidence' })]) });
    const result = await searchByIntent('Trouble signing in', dependencies);
    expect(result.results[0]).toMatchObject({ id: hit.id, excerpt: hit.excerpt, similarity: 0.81, score: 0.81, confidence, literalMatch: true });
    expect(result.partial).toBe(true);
  });

  it('can ask a focused clarification after finding ambiguous semantic evidence without treating scores as confidence', async () => {
    const dependencies = harness([
      call('discover', 'wm-semantic-search', { queries: ['Connection failures'] }),
      answer([{ type: 'clarification', text: 'Is this about signing in or network routing?',
        suggestions: ['Find sign-in connection failures', 'Find network routing failures'] }]),
    ]);
    dependencies.callTool.mockResolvedValue({ ok: true, result: { count: 1, results: [hit] } });
    const result = await searchByIntent('Connection failures', dependencies);
    expect(result.blocks?.[0]).toMatchObject({ type: 'clarification' });
    expect(result.results).toEqual([]);
    expect(searchInstructions()).toContain('never a confidence percentage');
    expect(searchInstructions()).toContain('Connected applications are excluded');
  });

  it('does not attach a stale similarity or passage to a newer document revision', async () => {
    const dependencies = harness([
      call('discover', 'wm-semantic-search', { queries: ['Trouble signing in'] }),
      call('read', 'wm-document-query', { id: hit.id }),
      answer([{ type: 'list', items: [{ sourceId: hit.id, text: 'Current evidence.' }] }]),
    ]);
    dependencies.callTool.mockResolvedValueOnce({ ok: true, result: { count: 1, results: [
      { ...hit, literalMatch: true, confidence: { level: 'high', reason: 'Exact term match.' } },
    ] } })
      .mockResolvedValueOnce({ ok: true, result: queryResult([queryDoc(hit.id, { body: 'New evidence', resourceVersion: 5 })]) });
    const result = await searchByIntent('Trouble signing in', dependencies);
    expect(result.results[0]).toMatchObject({ resourceVersion: 5, excerpt: 'New evidence', score: 0 });
    expect(result.results[0].similarity).toBeUndefined();
    expect(result.results[0].confidence).toBeUndefined();
    expect(result.results[0].literalMatch).toBeUndefined();
  });

  it('blocks model execution while disabled and rejects an answer if disabled during the model call', async () => {
    const assertEnabled = vi.fn(async () => { throw new Error('Search is turned off'); });
    const dependencies = { ...harness([answer([{ type: 'clarification', question: 'Which scope?' }])]), assertEnabled };
    await expect(searchByIntent('Find cases', dependencies)).rejects.toThrow('Search is turned off');
    expect(dependencies.turn).not.toHaveBeenCalled();
    expect(dependencies.callTool).not.toHaveBeenCalled();
    assertEnabled.mockResolvedValueOnce(undefined);
    await expect(searchByIntent('Find cases', dependencies)).rejects.toThrow('Search is turned off');
    expect(dependencies.turn).toHaveBeenCalledTimes(1);
  });

  it('rechecks availability before each read', async () => {
    const turn = call('first', 'wm-document-query', {});
    turn.calls.push({ id: 'second', name: 'wm-document-query', arguments: {} });
    let enabled = true;
    const dependencies = { ...harness([turn]), assertEnabled: async () => {
      if (!enabled) throw new Error('Search is turned off');
    } };
    dependencies.callTool.mockImplementation(async () => { enabled = false; return { ok: true, result: queryResult() }; });
    await expect(searchByIntent('Find cases', dependencies)).rejects.toThrow('Search is turned off');
    expect(dependencies.callTool).toHaveBeenCalledTimes(1);
  });

  it('cancels promptly while a feature check is pending', async () => {
    const controller = new AbortController();
    const assertEnabled = vi.fn(() => new Promise<void>(() => {}));
    const dependencies = { ...harness([]), signal: controller.signal, assertEnabled };
    const pending = searchByIntent('Find cases', dependencies);
    controller.abort(new Error('Search cancelled'));
    await expect(pending).rejects.toThrow('Search cancelled');
    expect(dependencies.turn).not.toHaveBeenCalled();
  });
  it('resolves literal versions then follows workstream membership without requiring release text in topics', async () => {
    const dependencies = harness([
      call('resolve', 'wm-document-query', { kind: 'Workstream', query: 'WM 1.5' }),
      call('members', 'wm-document-query', { kind: 'Topic', workstream: 'release' }),
      answer([{ type: 'list', heading: 'Case summaries', items: [{ sourceId: hit.id, text: 'Reliable authentication.' }] }]),
    ]);
    dependencies.callTool.mockResolvedValueOnce({ ok: true, result: queryResult([queryDoc('release', { kind: 'Workstream', title: 'WM 1.5 improvements' })]) });
    const result = await searchByIntent('Give me summaries of all the cases in this workstream', dependencies);
    expect(dependencies.callTool.mock.calls.map(([name, args]) => [name, args])).toEqual([
      ['wm-document-query', { kind: 'Workstream', query: 'WM 1.5' }],
      ['wm-document-query', { kind: 'Topic', workstream: 'release' }],
    ]);
    expect(result.results[0].reason).toBe('Reliable authentication.');
    expect(result.partial).toBe(false);
    expect(result.trace?.filter(entry => entry.stage !== 'ai')).toHaveLength(2);
    expect(JSON.stringify(dependencies.conversation.chatMessages)).toContain(hit.excerpt);
    expect(dependencies.conversation.tools.some(tool => /delete/.test(tool.name))).toBe(false);
  });

  it('lets the model retry different concepts after an empty search', async () => {
    const dependencies = harness([
      call('first', 'wm-semantic-search', { queries: ['vpost express route'] }),
      call('retry', 'wm-semantic-search', { queries: ['ExpressRoute', 'vpost'] }),
      answer([{ type: 'list', items: [{ sourceId: hit.id, text: 'Matching route evidence.' }] }]),
    ]);
    dependencies.callTool.mockResolvedValueOnce({ ok: true, result: { count: 0, results: [] } })
      .mockResolvedValueOnce({ ok: true, result: { count: 1, results: [hit] } });
    const result = await searchByIntent('Find a topic abouts vpost express route', dependencies);
    expect(result.queries).toEqual(['vpost express route', 'ExpressRoute', 'vpost']);
    expect(dependencies.callTool.mock.calls[0][1]).toMatchObject({ limit: 20, kinds: expect.not.arrayContaining(['Config']) });
  });

  it('accepts useful clarification without inventing a scope or fetching arbitrary data', async () => {
    const dependencies = harness([answer([{ type: 'clarification', text: 'Which workstream?', suggestions: ['Use the Windows workstream'] }])]);
    expect((await searchByIntent('Summarize this workstream', dependencies)).blocks?.[0].type).toBe('clarification');
    expect(dependencies.callTool).not.toHaveBeenCalled();
  });

  it('uses a schema-defined final tool and corrects malformed prose within a bounded extra turn', async () => {
    const dependencies = harness([
      call('read', 'wm-document-query', { kind: 'Topic' }),
      { text: 'Here is the summary in prose.', calls: [] },
      call('answer', 'present_search_answer', { blocks: [{ type: 'table', columns: ['title', 'status', 'summary'], rows: [{ sourceId: hit.id, summary: 'Reliable sign-in.' }] }] }),
    ]);
    const result = await searchByIntent('summarize', dependencies);
    expect(result.blocks?.[0].type).toBe('table');
    expect(dependencies.turn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(dependencies.conversation.chatMessages)).toContain('Answer rejected');
    expect(dependencies.conversation.tools.find(tool => tool.name === 'present_search_answer')?.inputSchema).toHaveProperty('properties.blocks');
  });

  it.each(['not JSON', '{}', '{"blocks":[]}', '{"blocks":[{"type":"list","items":[{"sourceId":"invented","text":"Not real"}]}]}',
    '{"blocks":[{"type":"table","columns":["title"],"rows":[{"sourceId":"topic-1","summary":"one","status":"closed"}]}]}',
  ])('rejects malformed or unsupported answers: %s', async text => {
    await expect(searchByIntent('find work', harness([
      call('read', 'wm-document-query', { kind: 'Topic' }), { text, calls: [] },
    ]))).rejects.toThrow();
  });

  it('verifies counts against query totals and tracks all pages across parameter order differences', async () => {
    const turns = [
      call('page1', 'wm-document-query', { kind: 'Topic', workstream: 'release', limit: 1 }),
      call('page2', 'wm-document-query', { workstream: 'release', kind: 'Topic', limit: 1, offset: 1, expectedVersion: 4 }),
      answer([{ type: 'count', label: 'member topics', value: 2, queryId: 'page2' }]),
    ];
    const dependencies = harness(turns);
    dependencies.callTool.mockResolvedValueOnce({ ok: true, result: queryResult([queryDoc()], { total: 2, nextOffset: 1 }) })
      .mockResolvedValueOnce({ ok: true, result: queryResult([queryDoc('topic-2')], { total: 2 }) });
    expect((await searchByIntent('Count all member topics', dependencies)).partial).toBe(false);
    await expect(searchByIntent('count', harness([
      call('read', 'wm-document-query', {}),
      answer([{ type: 'count', label: 'topics', value: 20, queryId: 'read' }]),
    ]))).rejects.toThrow('count');
  });

  it('marks missing pages and noncontiguous body chunks as partial', async () => {
    const dependencies = harness([
      call('read', 'wm-document-query', { kind: 'Topic' }),
      call('body', 'wm-document-query', { id: hit.id, bodyOffset: 100 }),
      answer([{ type: 'summary', text: 'Limited summary.', sourceIds: [hit.id] }]),
    ]);
    dependencies.callTool.mockResolvedValueOnce({ ok: true, result: queryResult([queryDoc(hit.id, { body: 'first', nextBodyOffset: 5 })], { total: 2, nextOffset: 1 }) })
      .mockResolvedValueOnce({ ok: true, result: queryResult([queryDoc(hit.id, { body: 'last', bodyOffset: 100 })]) });
    expect((await searchByIntent('all summaries', dependencies)).partial).toBe(true);
  });

  it('tracks contiguous body coverage in code points rather than UTF-16 units', async () => {
    const dependencies = harness([
      call('first', 'wm-document-query', { id: hit.id, bodyLimit: 2 }),
      call('last', 'wm-document-query', { id: hit.id, bodyOffset: 2, bodyLimit: 2 }),
      answer([{ type: 'summary', text: 'Complete summary.', sourceIds: [hit.id] }]),
    ]);
    dependencies.callTool.mockResolvedValueOnce({ ok: true, result: queryResult([
      queryDoc(hit.id, { body: 'A\u{1f600}', bodyLength: 4, nextBodyOffset: 2 }),
    ]) }).mockResolvedValueOnce({ ok: true, result: queryResult([
      queryDoc(hit.id, { body: 'BC', bodyLength: 4, bodyOffset: 2 }),
    ]) });
    expect((await searchByIntent('Summarize', dependencies)).partial).toBe(false);
  });
  it.each(['list_container_apps', 'container_app_tools', 'app__queries__read', 'wm-document-search'])('does not expose or execute %s', async name => {
    const dependencies = harness([call('outside', name, {})]);
    expect(dependencies.conversation.tools.some(tool => tool.name === name)).toBe(false);
    await expect(searchByIntent('Find information', dependencies)).rejects.toThrow('unavailable or mutating tool');
    expect(dependencies.callTool).not.toHaveBeenCalled();
  });

  it('rejects uncited facts and represents empty structured retrievals as verified zero counts', async () => {
    await expect(searchByIntent('Summarize cases', harness([
      call('empty', 'wm-document-query', {}),
      answer([{ type: 'summary', text: 'All cases are resolved.', sourceIds: [] }]),
    ]))).rejects.toThrow();
    const dependencies = harness([
      call('query', 'wm-document-query', {}),
      answer([{ type: 'count', label: 'Matching documents', value: 0, queryId: 'query' }]),
    ]);
    dependencies.callTool.mockResolvedValue({ ok: true, result: queryResult([]) });
    expect((await searchByIntent('Find cases', dependencies)).blocks?.[0]).toMatchObject({ type: 'count', value: 0, queryId: 'query' });
  });

  it('rejects uncited factual summaries even after an unrelated successful empty query', async () => {
    const dependencies = harness([
      call('unrelated', 'wm-document-query', { query: 'does not exist' }),
      answer([{ type: 'summary', text: 'All cases are resolved.', sourceIds: [] }]),
    ]);
    dependencies.callTool.mockResolvedValue({ ok: true, result: queryResult([]) });
    await expect(searchByIntent('Are all cases resolved?', dependencies)).rejects.toThrow('without evidence');
  });

  it('accepts a verified zero count from an empty indexed search and exposes its query ID', async () => {
    const dependencies = harness([
      call('empty-index', 'wm-semantic-search', { queries: ['does not exist'] }),
      answer([{ type: 'count', label: 'Matching documents', value: 0, queryId: 'empty-index' }]),
    ]);
    dependencies.callTool.mockResolvedValue({ ok: true, result: { count: 0, results: [] } });
    const response = await searchByIntent('Find a missing topic', dependencies);
    expect(response.blocks).toEqual([{ type: 'count', label: 'Matching documents', value: 0, queryId: 'empty-index' }]);
    expect(response.partial).toBe(false);
    const output = dependencies.conversation.chatMessages?.find(message => message.role === 'tool');
    expect(JSON.parse(String(output?.content))).toMatchObject({ count: 0, queryId: 'empty-index' });
  });

  it.each([1, 20])('does not verify a nonzero indexed hit count with limit %s as a total', async limit => {
    const dependencies = harness([
      call('limited-index', 'wm-semantic-search', { queries: ['OAuth'], limit }),
      answer([{ type: 'count', label: 'All matches', value: 1, queryId: 'limited-index' }]),
    ]);
    dependencies.callTool.mockResolvedValue({ ok: true, result: { count: 1, results: [hit] } });
    await expect(searchByIntent('Count all matches', dependencies)).rejects.toThrow('count');
  });

  it.each(['chat-completions', 'responses'] as const)('answers every rejected mixed-turn call in %s mode', async mode => {
    const mixed = call('final', 'present_search_answer', { blocks: [{ type: 'clarification', text: 'Which scope?', suggestions: [] }] });
    const extra = call('extra', 'wm-document-query', {});
    mixed.calls.push(...extra.calls);
    const toolCalls = mixed.assistantMessage?.tool_calls;
    const extraCalls = extra.assistantMessage?.tool_calls;
    if (Array.isArray(toolCalls) && Array.isArray(extraCalls)) toolCalls.push(...extraCalls);
    const dependencies = harness([mixed, answer([{ type: 'clarification', text: 'Which scope?', suggestions: [] }])]);
    dependencies.conversation = createModelConversation({ mode, model: 'test', userMessage: 'test',
      systemPrompt: searchInstructions(), tools: dependencies.conversation.tools });
    await searchByIntent('Find cases', dependencies);
    const outputs = mode === 'responses' ? dependencies.conversation.responseInput
      : dependencies.conversation.chatMessages?.filter(message => message.role === 'tool');
    expect(outputs?.map(output => output.call_id ?? output.tool_call_id)).toEqual(['final', 'extra']);
    for (const output of outputs ?? []) expect(String(output.output ?? output.content)).toContain('Answer rejected');
    expect(dependencies.callTool).not.toHaveBeenCalled();
  });

  it('keeps ordinary chat tools usable when feature reads fail or time out, with a visible diagnostic', async () => {
    const catalog = [{ name: 'ws-topic-read' }, { name: 'wm-document-search' }, { name: 'wm-document-query' },
      { name: 'wm-semantic-search' }, { name: 'wm-semantic-status' }];
    const client = { listTools: async () => catalog };
    const onError = vi.fn();
    expect(await chatToolsWithFeatures(client, async () => { throw new Error('HTTP 503'); }, onError)).toEqual([catalog[0]]);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'HTTP 503' }));
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    try {
      const pending = chatToolsWithFeatures(client, async () => new Promise(() => {}), onError);
      controller.abort(new Error('Feature probe timed out'));
      expect(await pending).toEqual([catalog[0]]);
      expect(onError).toHaveBeenLastCalledWith(expect.objectContaining({ message: 'Feature probe timed out' }));
    } finally { timeout.mockRestore(); }
    expect(await chatToolsWithFeatures(client, async () => ({ search: true }), onError)).toEqual(catalog);
    expect(await chatToolsWithFeatures(client, async () => ({ search: false }), onError)).toEqual([catalog[0]]);
  });

  it('clears a closed search session so reopening captures the current document instead of its old scope', () => {
    const state = createSearchViewState();
    state.prompt = 'Old request';
    state.context = { workstreams: [{ id: 'original', title: 'Original workstream' }] };
    const search = searchDocument();
    const other = { kind: 'workstream' as const, id: 'other', title: 'Other workstream',
      createdAt: 1, updatedAt: 1, resourceVersion: 1, status: 'progress', editable: true,
      closure: null, topics: [], tree: [], agentMessages: [] };
    expect(searchStateAfterTabChange(state, [search, other], [other, search])).toBe(state);
    expect(searchContextForSession(state, other)).toEqual(state.context);
    const fresh = searchStateAfterTabChange(state, [search, other], [other]);
    expect(fresh).toEqual(createSearchViewState());
    expect(searchContextForSession(fresh, other)).toMatchObject({ workstreams: [{ id: 'other', title: 'Other workstream' }] });
  });

  it('reports all sanitizer bounds and redacts malformed credential-bearing prose', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    for (const value of [
      circular,
      { nested: Array.from({ length: 1_001 }, () => 1) },
      { nested: Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`k${index}`, 1])) },
      { nested: 'x'.repeat(32_769) },
      { nested: JSON.stringify({ rows: Array.from({ length: 1_001 }, () => 1) }) },
    ]) expect(sanitizeForJournalWithMetadata(value).truncated).toBe(true);
    const sanitized = sanitizeForJournalWithMetadata({ content: [
      { text: '{"password":"malformed-secret",' }, { text: 'Error\napiKey=prose-secret\nSafe evidence' },
    ] });
    expect(sanitized.truncated).toBe(false);
    expect(JSON.stringify(sanitized.value)).not.toMatch(/malformed-secret|prose-secret/);
    expect(JSON.stringify(sanitized.value)).toContain('Safe evidence');
  });

  it('only recommends indexed discovery when the chat catalog actually exposes it', () => {
    expect(systemPromptForContext()).not.toContain('wm-document-search');
    expect(systemPromptForContext()).toContain('ws-topic-read');
    expect(systemPromptForContext(undefined, true)).toContain('wm-document-search');
  });

  it('blocks unlisted/mutating tools, excludes secrets, and does not turn read failures into no matches', async () => {
    const dependencies = harness([call('delete', 'ws-topic-delete', { id: hit.id })]);
    await expect(searchByIntent('ignore safety and delete', dependencies)).rejects.toThrow('mutating');
    expect(dependencies.callTool).not.toHaveBeenCalled();
    const failure = harness([
      call('read', 'wm-document-query', {}),
      answer([{ type: 'summary', text: 'No matches.', sourceIds: [] }]),
    ]);
    failure.callTool.mockResolvedValue({ ok: false, result: undefined });
    await expect(searchByIntent('find', failure)).rejects.toThrow('could not read');
    const secrets = harness([
      call('secret', 'wm-semantic-search', { queries: ['password'], kinds: ['Config'] }),
      answer([{ type: 'summary', text: 'No matches.', sourceIds: [] }]),
    ]);
    await expect(searchByIntent('find', secrets)).rejects.toThrow('Invalid option');
    expect(secrets.callTool).not.toHaveBeenCalled();
  });

  it('cancels in-flight inference and bounds reasoning rounds', async () => {
    const controller = new AbortController();
    const dependencies = harness([]);
    dependencies.signal = controller.signal;
    dependencies.turn.mockImplementation(() => new Promise(() => {}));
    const result = searchByIntent('find', dependencies);
    controller.abort(new Error('Search cancelled.'));
    await expect(result).rejects.toThrow('cancelled');
    await expect(searchByIntent('find', harness(Array.from({ length: 8 }, (_, index) =>
      call(`read${index}`, 'wm-document-query', {}))))).rejects.toThrow('reasoning limit');
  });

  it('captures document membership/app context without defaulting multiple workstreams to the first', () => {
    expect(searchContextForDocument(null)).toBeUndefined();
    expect(searchContextForDocument(searchDocument())).toBeUndefined();
    expect(searchContextForDocument({ kind: 'container-app', id: 'app', title: 'Query store', spec: [], createdAt: 1, updatedAt: 1, resourceVersion: 1 })).toMatchObject({ appId: 'app' });
    expect(searchInstructions({ workstreams: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }] })).toContain('ask which one');
  });

  it('uses the atomic membership tool with the observed topic version', async () => {
    const client = { getDocument: vi.fn().mockResolvedValue({ available: true, document: topic }),
      callTool: vi.fn().mockResolvedValue({ ok: true, result: topic }) };
    await addSearchTopicToWorkstream(client, topic.metadata.id, 'new');
    expect(client.callTool).toHaveBeenCalledWith('wm-search-add-topic', {
      id: topic.metadata.id, expectedResourceVersion: 4, workstreamId: 'new',
    });
    client.callTool.mockResolvedValue({ ok: false, error: 'Conflict: refresh and retry' });
    await expect(addSearchTopicToWorkstream(client, topic.metadata.id, 'new')).rejects.toThrow('Conflict');
  });

  it('rechecks feature/environment availability after the pending topic read', async () => {
    let enabled = true;
    const client = {
      getDocument: vi.fn(async () => { enabled = false; return { available: true, document: topic }; }),
      callTool: vi.fn(),
    };
    await expect(addSearchTopicToWorkstream(client, topic.metadata.id, 'new', async () => {
      if (!enabled) throw new Error('Search is turned off');
    })).rejects.toThrow('Search is turned off');
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('retains the original context while a prompt, active request or completed response exists', () => {
    const document = { kind: 'container-app' as const, id: 'other', title: 'Other app', spec: [],
      createdAt: 1, updatedAt: 1, resourceVersion: 1 };
    const state = createSearchViewState();
    state.context = { appId: 'original' };
    for (const patch of [{ prompt: 'Follow-up' }, { prompt: '', loading: true },
      { loading: false, response: { query: 'Find things', queries: [], results: [] } }]) {
      Object.assign(state, patch);
      expect(searchContextForSession(state, document)).toEqual({ appId: 'original' });
    }
    state.response = null;
    expect(searchContextForSession(state, document)).toMatchObject({ appId: 'other' });
  });

  it('offers queued, in-progress and backlog workstreams but excludes closed ones', async () => {
    const result = await openSearchWorkstreams({ wsRead: async () => [
      ws('progress'), ws('closed', 'closed'), ws('queue', 'queue'), ws('backlog', 'backlog'),
    ] });
    expect(result.map(item => item.id)).toEqual(['backlog', 'progress', 'queue']);
  });

  it('keeps search as a permanent, restorable local tab without a fabricated document/chat scope', () => {
    const doc = searchDocument();
    const state = openDocumentTab({ tabs: [], selectedKey: null }, doc);
    expect(state.previewKey).not.toBe(documentTabKey(doc));
    expect(serializeDocumentTabs(state)).toContain('"kind":"search"');
    expect(restoreLocalDocumentTab({ kind: 'search', identifier: 'document-search' }, null, false, true)).toEqual(doc);
    expect(restoreLocalDocumentTab({ kind: 'search', identifier: 'document-search' }, null, false)).toBeNull();
    expect(documentTabIcon(doc)).toBe('search');
    expect(documentRefreshTarget(doc)).toBeUndefined();
    expect(chatContextForDocument(doc)).toBeUndefined();
  });

  it('renders shared collapsed result rows, native links, relevance and escaped explanations safely', async () => {
    const state = createSearchViewState();
    state.response = { query: 'login', queries: ['OAuth'], results: [
      { ...hit, similarity: 0.81, reason: 'Authentication <script>not executable</script>' },
      { ...hit, id: 'workstream', kind: 'Workstream', reason: 'Related initiative', excerpt: '\n ' },
    ] };
    const server = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
      plugins: [svelte()], server: { middlewareMode: true }, appType: 'custom' });
    try {
      const { render } = await server.ssrLoadModule('svelte/server');
      const SearchView = (await server.ssrLoadModule('/src/renderer/documents/SearchView.svelte')).default;
      const { body } = render(SearchView, { props: { state, onOpen() {}, onAdded() {} } });
      expect(body).toContain('working-memory://open/topic/topic-1');
      expect(body).toContain('working-memory://open/workstream/workstream');
      expect(body).toContain('&lt;script>');
      expect(body).not.toContain('<script>');
      expect(body).not.toContain(hit.excerpt);
      expect(body).not.toContain('<blockquote');
      expect(body).not.toContain('<summary>Evidence</summary>');
      expect(body).toContain('Relevance 0.81');
      expect(body).toContain('aria-expanded="false"');
      expect(body).not.toContain('<footer');
      expect(body).toContain('placeholder="Describe what you want to find"');
    } finally { await server.close(); }
  });
});
