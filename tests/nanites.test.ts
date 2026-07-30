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
  async topicRead(input: { slug?: string }): Promise<Topic[]> {
    if (!this.topic) {
      return [];
    }
    return input.slug === this.topic.slug ? [this.topic] : [];
  }
  async naniteRun(input: NaniteRunInput): Promise<Nanite> {
    this.runCalls.push(input);
    return fakeNanite();
  }
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
    // The runner seeded the bridge with the TEMPLATE's config and the TOPIC body.
    expect(bridge.started?.instructions).toBe('Scan open topics and raise deduped alerts.');
    expect(bridge.started?.prompt).toBe('Do the thing described here.');
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
    expect(bridge.started?.prompt).toBe('Do the thing described here.');
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
