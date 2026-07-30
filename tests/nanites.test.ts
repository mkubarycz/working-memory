import { describe, expect, test } from 'vitest';
import { runNanite } from '../src/nanites/runner';
import {
  ExtensionHostNaniteRunner,
  type NaniteRunnerClient,
} from '../src/nanites/extensionHostRunner';
import {
  NaniteRunnerRegistry,
  providerFromSettings,
} from '../src/nanites/registry';
import type {
  NaniteConversation,
  NaniteConversationSeed,
  NaniteJudgeRequest,
  NaniteJudgeResult,
  NaniteLmBridge,
  NaniteModelTurn,
  NaniteRunResult,
  NaniteRunner,
  NaniteTokenUsage,
  RunNaniteOptions,
} from '../src/nanites/types';
import type {
  Nanite,
  NaniteRunInput,
  NaniteTemplate,
  Topic,
  Workstream,
} from '../src/controlPlaneClient';

// ---------------------------------------------------------------------------
// Scripted fake bridge: deterministic stand-in for the vscode.lm loop. The
// runner core takes no vscode dependency (it uses this injected bridge), so
// these tests need no vscode mock.
// ---------------------------------------------------------------------------
const DEFAULT_CONVO_USAGE: NaniteTokenUsage = {
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
};
const DEFAULT_JUDGE: NaniteJudgeResult = {
  request_summary: 'asked to scan open topics and raise deduped alerts',
  response_summary: 'scanned topics and flagged the followups',
  confidence: 100,
  rationale: 'meets the criteria',
  model: 'test-model',
  tokens: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
};

interface BridgeOpts {
  modelId?: string;
  usage?: NaniteTokenUsage;
  judge?: NaniteJudgeResult;
  startError?: string;
}

class ScriptedConversation implements NaniteConversation {
  private i = 0;
  public readonly results: Array<{ callId: string; text: string }> = [];
  public readonly modelId: string;
  constructor(
    private readonly turns: NaniteModelTurn[],
    private readonly tokenUsage: NaniteTokenUsage = DEFAULT_CONVO_USAGE,
    modelId = 'test-model',
  ) {
    this.modelId = modelId;
  }
  async next(): Promise<NaniteModelTurn> {
    return this.turns[this.i++] ?? { text: '', toolCalls: [] };
  }
  addToolResult(callId: string, _name: string, resultText: string): void {
    this.results.push({ callId, text: resultText });
  }
  usage(): NaniteTokenUsage {
    return this.tokenUsage;
  }
}

class ScriptedBridge implements NaniteLmBridge {
  public started?: NaniteConversationSeed;
  public judged?: NaniteJudgeRequest;
  public readonly invoked: Array<{ name: string; input: unknown }> = [];
  constructor(
    private readonly turns: NaniteModelTurn[],
    private readonly handler: (name: string, input: unknown) => string = () =>
      JSON.stringify({ ok: true }),
    private readonly opts: BridgeOpts = {},
  ) {}
  async start(seed: NaniteConversationSeed): Promise<NaniteConversation> {
    this.started = seed;
    if (this.opts.startError) {
      throw new Error(this.opts.startError);
    }
    return new ScriptedConversation(
      this.turns,
      this.opts.usage ?? DEFAULT_CONVO_USAGE,
      this.opts.modelId ?? 'test-model',
    );
  }
  async invokeTool(name: string, input: unknown): Promise<string> {
    this.invoked.push({ name, input });
    return this.handler(name, input);
  }
  async judge(request: NaniteJudgeRequest): Promise<NaniteJudgeResult> {
    this.judged = request;
    return this.opts.judge ?? DEFAULT_JUDGE;
  }
}

const BASE_OPTS: RunNaniteOptions = {
  instructions: 'Scan open topics and raise deduped alerts.',
  prompt: 'Flag followups and reminders',
  allowlist: ['wm_list_topics', 'wm_get_topic', 'wm_list_alerts', 'wm_create_alert'],
  acceptanceCriteria: 'Every open followup topic is flagged with a deduped alert.',
  acceptanceThreshold: 60,
};

// ---------------------------------------------------------------------------
// Runner core (pure, no vscode, no persistence)
// ---------------------------------------------------------------------------
describe('runNanite (core)', () => {
  test('drives the tool-calling loop, enforces the allow-list', async () => {
    const bridge = new ScriptedBridge([
      { text: '', toolCalls: [{ callId: '1', name: 'wm_list_topics', input: {} }] },
      {
        text: 'flagging',
        toolCalls: [
          { callId: '2', name: 'wm_create_alert', input: { topic_slugs: ['topic-a'] } },
          { callId: '3', name: 'wm_delete_topic', input: { slug: 'topic-a' } },
        ],
      },
      { text: 'Done: flagged 1 topic.', toolCalls: [] },
    ]);

    const result = await runNanite(bridge, {
      ...BASE_OPTS,
      allowlist: ['wm_list_topics', 'wm_create_alert'],
    });

    expect(result.status).toBe('succeeded');
    expect(result.iterations).toBe(3);
    expect(result.output).toBe('Done: flagged 1 topic.');
    expect(result.requestSummary).toBeTruthy();
    expect(result.responseSummary).toBeTruthy();
    expect(result.acceptance?.summary).toBeTruthy();

    // The judge was handed the full tool-call trail (name + ok + optional error).
    expect(bridge.judged?.toolCalls).toEqual(result.toolCalls);
    expect(bridge.judged?.toolCalls.map((t) => t.name)).toEqual([
      'wm_list_topics',
      'wm_create_alert',
      'wm_delete_topic',
    ]);
    // Allow-listed calls dispatched; the forbidden one was refused, not invoked.
    expect(bridge.invoked.map((i) => i.name)).toEqual([
      'wm_list_topics',
      'wm_create_alert',
    ]);
    const forbidden = result.toolCalls.find((t) => t.name === 'wm_delete_topic');
    expect(forbidden?.ok).toBe(false);
    expect(forbidden?.error).toMatch(/allow-list/);
  });

  // bug: acceptance-evaluator-requires-tool-evidence — the judge must be told
  // whether tools were even available, so it can't demand tool-call evidence a
  // no-tools run could never produce.
  test('judge is told tools WERE available when the allow-list is non-empty', async () => {
    const bridge = new ScriptedBridge([{ text: 'done', toolCalls: [] }]);
    await runNanite(bridge, BASE_OPTS);
    expect(bridge.judged?.toolsAvailable).toBe(true);
  });

  test('judge is told NO tools were available when the allow-list is empty', async () => {
    const bridge = new ScriptedBridge([
      { text: 'Checked the topic for due-dated items; found none; no errors.', toolCalls: [] },
    ]);
    const result = await runNanite(bridge, {
      ...BASE_OPTS,
      allowlist: [],
      acceptanceCriteria:
        'Accept when it reports it checked the topic for due-dated tasks/reminders and hit no errors.',
    });
    expect(bridge.judged?.toolsAvailable).toBe(false);
    expect(bridge.judged?.toolCalls).toEqual([]);
    // With the default (passing) judge, an empty allow-list run still succeeds.
    expect(result.status).toBe('succeeded');
  });

  test('acceptance passes when confidence >= threshold', async () => {
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }], undefined, {
      judge: {
        request_summary: 'restated request',
        response_summary: 'summarized response',
        confidence: 75,
        rationale: 'clears the bar',
        model: 'test-model',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });

    const result = await runNanite(bridge, { ...BASE_OPTS, acceptanceThreshold: 60 });

    expect(result.status).toBe('succeeded');
    expect(result.error).toBeUndefined();
    expect(result.acceptance).toMatchObject({
      summary: 'clears the bar',
      confidence: 75,
      threshold: 60,
      passed: true,
    });
    expect(result.requestSummary).toBe('restated request');
    expect(result.responseSummary).toBe('summarized response');
    // The judge saw the criteria, prompt, and the final output.
    expect(bridge.judged?.criteria).toBe(BASE_OPTS.acceptanceCriteria);
    expect(bridge.judged?.prompt).toBe(BASE_OPTS.prompt);
    expect(bridge.judged?.output).toBe('Done.');
  });

  test('acceptance fails below threshold → "Acceptance Criteria Not Matched"', async () => {
    const bridge = new ScriptedBridge([{ text: 'Half done.', toolCalls: [] }], undefined, {
      judge: {
        request_summary: 'restated request',
        response_summary: 'only half done',
        confidence: 40,
        rationale: 'missed two topics',
        model: 'test-model',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });

    const result = await runNanite(bridge, { ...BASE_OPTS, acceptanceThreshold: 60 });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Acceptance Criteria Not Matched');
    expect(result.acceptance).toMatchObject({
      summary: 'missed two topics',
      confidence: 40,
      threshold: 60,
      passed: false,
    });
    // A failed run still carries its output + summaries.
    expect(result.output).toBe('Half done.');
    expect(result.responseSummary).toBe('only half done');
  });

  test('records model + summed loop/judge token usage', async () => {
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }], undefined, {
      modelId: 'gpt-test',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      judge: {
        request_summary: 'req',
        response_summary: 'res',
        confidence: 90,
        rationale: 'good',
        model: 'gpt-test',
        tokens: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      },
    });

    const result = await runNanite(bridge, BASE_OPTS);

    expect(result.status).toBe('succeeded');
    expect(result.model).toBe('gpt-test');
    // Loop (10/5) + judge (3/2) folded together.
    expect(result.tokens).toEqual({
      input_tokens: 13,
      output_tokens: 7,
      total_tokens: 20,
    });
  });

  test('infra failure (bridge cannot start) → failed result, never throws', async () => {
    const bridge = new ScriptedBridge([], undefined, {
      startError: 'no language model available',
    });

    const result = await runNanite(bridge, BASE_OPTS);

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/no language model available/);
    expect(result.acceptance).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Extension-host runner: reads template + input topic, persists Running then
// terminal + result through an injected control-plane client.
// ---------------------------------------------------------------------------
function fakeTemplate(over: Partial<NaniteTemplate> = {}): NaniteTemplate {
  return {
    id: 'tpl-id',
    slug: 'tpl',
    title: 'Flag followups',
    triggerPhrase: 'Flag followups',
    instructions: 'Scan open topics and raise deduped alerts.',
    executionSettings: {},
    toolAllowlist: ['wm_create_alert'],
    inputSchema: {},
    outputSchema: {},
    acceptanceCriteria: 'Every open followup topic is flagged.',
    acceptanceThreshold: 60,
    enabled: true,
    created_at: 0,
    updated_at: 0,
    resourceVersion: 1,
    ...over,
  };
}

function fakeNanite(over: Partial<Nanite> = {}): Nanite {
  return {
    id: 'n1',
    slug: null,
    templateId: 'tpl',
    workstream: 'ws',
    inputTopic: 'topic-a',
    request: '',
    phase: 'Pending',
    startedAt: null,
    endedAt: null,
    error: '',
    output: '',
    acceptance: null,
    toolCalls: [],
    tokens: null,
    created_at: 0,
    updated_at: 0,
    resourceVersion: 1,
    ...over,
  };
}

function fakeTopic(over: Partial<Topic> = {}): Topic {
  return {
    id: 't-id',
    slug: 'topic-a',
    title: 'Topic A',
    body: 'Do the thing described here.',
    status: 'open',
    topicType: 'note',
    parents: [],
    workstreams: ['ws'],
    focusedWorkstreams: [],
    created_at: 0,
    updated_at: 0,
    resourceVersion: 1,
    ...over,
  };
}

class FakeClient implements NaniteRunnerClient {
  public readonly runCalls: NaniteRunInput[] = [];
  constructor(
    private readonly template: NaniteTemplate | null,
    private readonly topic: Topic | null,
    private readonly workstreamTopics: Topic[] = [],
  ) {}
  async naniteTemplateRead(input: { slug?: string; id?: string }): Promise<NaniteTemplate[]> {
    if (!this.template) {
      return [];
    }
    if (input.slug !== undefined) {
      return input.slug === this.template.slug ? [this.template] : [];
    }
    if (input.id !== undefined) {
      return input.id === this.template.id ? [this.template] : [];
    }
    return [this.template];
  }
  async topicRead(input: { slug?: string; workstream?: string }): Promise<Topic[]> {
    if (input.workstream !== undefined) {
      return this.workstreamTopics.filter((t) => t.workstreams.includes(input.workstream!));
    }
    if (!this.topic) {
      return [];
    }
    return input.slug === this.topic.slug ? [this.topic] : [];
  }
  async wsRead(input: { slug?: string }): Promise<Workstream[]> {
    const ws = fakeWorkstream();
    return input.slug === ws.slug ? [ws] : [];
  }
  async naniteRun(input: NaniteRunInput): Promise<Nanite> {
    this.runCalls.push(input);
    return fakeNanite();
  }
}

function fakeWorkstream(over: Partial<Workstream> = {}): Workstream {
  return {
    id: 'ws-id',
    slug: 'ws',
    title: 'Peanut Harvest',
    status: 'progress',
    closure: null,
    opened_at: 0,
    updated_at: 0,
    closed_at: null,
    resourceVersion: 1,
    ...over,
  };
}

describe('ExtensionHostNaniteRunner', () => {
  test('reads topic body as prompt + template config, persists Running then terminal', async () => {
    const client = new FakeClient(fakeTemplate(), fakeTopic());
    const bridge = new ScriptedBridge([
      { text: '', toolCalls: [{ callId: '1', name: 'wm_create_alert', input: {} }] },
      { text: 'Done.', toolCalls: [] },
    ]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    const result = await runner.run(fakeNanite());

    expect(result.status).toBe('succeeded');
    // The runner seeded the bridge with the TEMPLATE's config and a prompt
    // carrying the workstream + input topic context.
    expect(bridge.started?.instructions).toBe('Scan open topics and raise deduped alerts.');
    expect(bridge.started?.prompt).toContain('Do the thing described here.'); // topic body
    expect(bridge.started?.prompt).toContain('Topic A'); // topic title
    expect(bridge.started?.prompt).toContain('Peanut Harvest'); // workstream context
    expect(bridge.started?.allowlist).toEqual(['wm_create_alert']);
    // The allow-listed tool was actually invoked.
    expect(bridge.invoked.map((i) => i.name)).toEqual(['wm_create_alert']);

    // Two persistence calls: Pending→Running (no outcome), then the terminal
    // call carrying the result.
    expect(client.runCalls).toHaveLength(2);
    expect(client.runCalls[0]).toEqual({ id: 'n1' });
    const finish = client.runCalls[1];
    expect(finish.id).toBe('n1');
    expect(finish.outcome).toBe('succeeded');
    expect(finish.output).toBe('Done.');
    expect(finish.acceptance).toMatchObject({ passed: true, threshold: 60 });
    expect(finish.toolCalls?.map((t) => t.name)).toEqual(['wm_create_alert']);
  });

  test('no template → runs against the topic with empty instructions/allowlist', async () => {
    const client = new FakeClient(null, fakeTopic());
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    const result = await runner.run(fakeNanite({ templateId: null }));

    expect(result.status).toBe('succeeded');
    expect(bridge.started?.instructions).toBe('');
    expect(bridge.started?.allowlist).toEqual([]);
    expect(bridge.started?.prompt).toContain('Do the thing described here.');
  });

  test('workstream-wide nanite (no input topic) seeds a topic INDEX, not a body', async () => {
    const topics = [
      fakeTopic({ slug: 'topic-a', title: 'Topic A', body: 'body a' }),
      fakeTopic({ slug: 'topic-b', title: 'Topic B', body: 'body b' }),
    ];
    const client = new FakeClient(fakeTemplate(), null, topics);
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    const result = await runner.run(fakeNanite({ inputTopic: '' }));

    expect(result.status).toBe('succeeded');
    // The prompt lists the workstream's topics as an INDEX (title + slug +
    // status) and invites a ws-topic-read tool call — it does NOT inline bodies.
    expect(bridge.started?.prompt).toContain('# Topics in this workstream');
    expect(bridge.started?.prompt).toContain('Topic A (topic-a) — open');
    expect(bridge.started?.prompt).toContain('Topic B (topic-b) — open');
    expect(bridge.started?.prompt).toContain('ws-topic-read');
    expect(bridge.started?.prompt).not.toContain('body a');
    expect(bridge.started?.prompt).not.toContain('# Input topic');
    // Workstream context is still present.
    expect(bridge.started?.prompt).toContain('Peanut Harvest');
  });

  test('failed acceptance is persisted as a Failed terminal call', async () => {
    const client = new FakeClient(fakeTemplate(), fakeTopic());
    const bridge = new ScriptedBridge([{ text: 'Nope.', toolCalls: [] }], undefined, {
      judge: {
        request_summary: 'r',
        response_summary: 'r',
        confidence: 10,
        rationale: 'missed it',
        model: 'test-model',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    const result = await runner.run(fakeNanite());

    expect(result.status).toBe('failed');
    const finish = client.runCalls[1];
    expect(finish.outcome).toBe('failed');
    expect(finish.error).toBe('Acceptance Criteria Not Matched');
    expect(finish.acceptance).toMatchObject({ passed: false });
  });
});

// ---------------------------------------------------------------------------
// Error handling: no unbounded await may strand a nanite (bug: workstream-wide
// nanite stalls). Every control-plane read/write is time-boxed.
// ---------------------------------------------------------------------------
describe('ExtensionHostNaniteRunner error handling', () => {
  /** Build a bare NaniteRunnerClient with per-method overrides. */
  function makeClient(over: Partial<NaniteRunnerClient> & { runCalls?: NaniteRunInput[] }): NaniteRunnerClient {
    const runCalls = over.runCalls ?? [];
    return {
      naniteTemplateRead: over.naniteTemplateRead ?? (async () => [fakeTemplate()]),
      wsRead: over.wsRead ?? (async () => [fakeWorkstream()]),
      topicRead: over.topicRead ?? (async () => [fakeTopic()]),
      naniteRun:
        over.naniteRun ??
        (async (i) => {
          runCalls.push(i);
          return fakeNanite();
        }),
    };
  }

  const HANG = <T>(): Promise<T> => new Promise<T>(() => {});

  test('a hung input read fails fast and leaves the nanite Pending', async () => {
    const runCalls: NaniteRunInput[] = [];
    const client = makeClient({
      runCalls,
      // The workstream-wide topic-index read hangs forever.
      topicRead: async (input) => (input.workstream !== undefined ? HANG<Topic[]>() : []),
      naniteRun: async (i) => {
        runCalls.push(i);
        return fakeNanite();
      },
    });
    const bridge = new ScriptedBridge([{ text: 'x', toolCalls: [] }]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge, readTimeoutMs: 20 });

    const result = await runner.run(fakeNanite({ inputTopic: '' }));

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/could not resolve nanite inputs/);
    expect(result.error).toMatch(/read workstream topics timed out/);
    // Never flipped to Running — no persist happened, so a retry is safe.
    expect(runCalls).toHaveLength(0);
    expect(bridge.started).toBeUndefined();
  });

  test('a hung Running flip fails fast without invoking the model', async () => {
    const client = makeClient({
      naniteRun: async (i) => (i.outcome === undefined ? HANG<Nanite>() : fakeNanite()),
    });
    const bridge = new ScriptedBridge([{ text: 'done', toolCalls: [] }]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge, persistTimeoutMs: 20 });

    const result = await runner.run(fakeNanite());

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/could not start nanite/);
    expect(bridge.started).toBeUndefined();
  });

  test('a hung result persist fails the run instead of stalling in Running', async () => {
    const runCalls: NaniteRunInput[] = [];
    const client = makeClient({
      runCalls,
      // The Running flip resolves; the terminal write hangs forever.
      naniteRun: async (i) => {
        runCalls.push(i);
        return i.outcome !== undefined ? HANG<Nanite>() : fakeNanite();
      },
    });
    const bridge = new ScriptedBridge([{ text: 'done', toolCalls: [] }]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge, persistTimeoutMs: 20 });

    const result = await runner.run(fakeNanite());

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/could not be saved/);
    // The run DID flip to Running and DID attempt the terminal write.
    expect(runCalls[0]).toEqual({ id: 'n1' });
    expect(runCalls.some((c) => c.outcome === 'succeeded')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------
describe('NaniteRunnerRegistry', () => {
  const makeRunner = (id: string): NaniteRunner => ({
    id,
    run: async (): Promise<NaniteRunResult> => ({
      status: 'succeeded',
      output: '',
      toolCalls: [],
      iterations: 0,
      hitIterationCap: false,
    }),
  });

  test('resolves a registered provider by id, else the default', () => {
    const registry = new NaniteRunnerRegistry('extension-host');
    registry.register(makeRunner('extension-host'));
    registry.register(makeRunner('cli'));

    expect(registry.resolve('cli').id).toBe('cli');
    expect(registry.resolve('extension-host').id).toBe('extension-host');
    // Unknown / absent → default.
    expect(registry.resolve('nope').id).toBe('extension-host');
    expect(registry.resolve(null).id).toBe('extension-host');
    expect(registry.resolve().id).toBe('extension-host');
  });

  test('throws when the default was never registered', () => {
    const registry = new NaniteRunnerRegistry('extension-host');
    expect(() => registry.resolve()).toThrow(/no default nanite runner/);
  });

  test('providerFromSettings reads executionSettings.provider defensively', () => {
    expect(providerFromSettings({ provider: 'cli' })).toBe('cli');
    expect(providerFromSettings({ provider: '  ' })).toBeNull();
    expect(providerFromSettings({})).toBeNull();
    expect(providerFromSettings(undefined)).toBeNull();
    expect(providerFromSettings({ provider: 42 } as never)).toBeNull();
  });
});
