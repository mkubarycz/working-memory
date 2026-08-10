import { describe, expect, test } from 'vitest';
import { runNanite } from '../src/nanites/runner';
import {
  ExtensionHostNaniteRunner,
  type NaniteRunnerClient,
} from '../src/nanites/extensionHostRunner';
import { matchesToolName, resolveToolPlan } from '../src/nanites/toolNames';
import { stripPrivilegedNaniteArgs } from '../src/nanites/toolNames';
import {
  NaniteRunnerRegistry,
  providerFromSettings,
} from '../src/nanites/registry';
import type {
  NaniteConversation,
  NaniteConversationSeed,
  NaniteContainer,
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
  pass: true,
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
  /** Simulated registered-tool catalog (defaults to the seed allow-list). */
  available?: string[];
}

class ScriptedConversation implements NaniteConversation {
  private i = 0;
  public readonly results: Array<{ callId: string; text: string }> = [];
  public readonly modelId: string;
  constructor(
    private readonly turns: NaniteModelTurn[],
    private readonly tokenUsage: NaniteTokenUsage = DEFAULT_CONVO_USAGE,
    modelId = 'test-model',
    public readonly grantedTools: string[] = [],
    public readonly missingTools: string[] = [],
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
    // Mirror the real bridge: resolve the tool policy against a catalog. The
    // catalog defaults to the allow-list itself (everything requested is
    // available); pass `available` to simulate missing / prefixed tools.
    const available = this.opts.available ?? seed.allowlist.filter((a) => a !== '*');
    const plan = resolveToolPlan(available, seed.allowlist, seed.denylist);
    return new ScriptedConversation(
      this.turns,
      this.opts.usage ?? DEFAULT_CONVO_USAGE,
      this.opts.modelId ?? 'test-model',
      plan.granted.map((g) => g.offer),
      plan.missing,
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
    expect(forbidden?.error).toMatch(/not granted/);
  });

  test('records an ordered execution trace: narration interleaved with tool calls', async () => {
    const bridge = new ScriptedBridge(
      [
        {
          text: 'Looking up the open topics first.',
          toolCalls: [{ callId: '1', name: 'wm_list_topics', input: { status: 'open' } }],
        },
        {
          text: 'Now flagging and trying a denied delete.',
          toolCalls: [
            { callId: '2', name: 'wm_create_alert', input: { topic_slugs: ['topic-a'] } },
            { callId: '3', name: 'wm_delete_topic', input: { slug: 'topic-a' } },
          ],
        },
        { text: 'Done: flagged 1 topic.', toolCalls: [] },
      ],
      (name) => JSON.stringify({ ok: true, tool: name }),
    );

    const result = await runNanite(bridge, {
      ...BASE_OPTS,
      allowlist: ['wm_list_topics', 'wm_create_alert'],
    });

    // The trace preserves order: narration, its tool call, narration, both
    // tool calls (granted then denied). The final response is NOT a step.
    expect(result.steps.map((s) => (s.kind === 'assistant' ? `say:${s.text}` : `tool:${s.name}`))).toEqual([
      'say:Looking up the open topics first.',
      'tool:wm_list_topics',
      'say:Now flagging and trying a denied delete.',
      'tool:wm_create_alert',
      'tool:wm_delete_topic',
    ]);

    // Granted calls carry an args preview + a result preview; the denied one
    // carries the args + the not-granted error instead of a result.
    const listStep = result.steps.find((s) => s.name === 'wm_list_topics');
    expect(listStep?.ok).toBe(true);
    expect(listStep?.input).toContain('open');
    expect(listStep?.result).toContain('wm_list_topics');
    const deniedStep = result.steps.find((s) => s.name === 'wm_delete_topic');
    expect(deniedStep?.ok).toBe(false);
    expect(deniedStep?.error).toMatch(/not granted/);
    expect(deniedStep?.result).toBeUndefined();
  });

  test('truncates oversized step previews so the persisted trace stays bounded', async () => {
    const huge = 'x'.repeat(5000);
    const bridge = new ScriptedBridge(
      [
        { text: '', toolCalls: [{ callId: '1', name: 'wm_list_topics', input: { blob: huge } }] },
        { text: 'Done.', toolCalls: [] },
      ],
      () => huge,
    );

    const result = await runNanite(bridge, { ...BASE_OPTS, allowlist: ['wm_list_topics'] });

    const step = result.steps.find((s) => s.name === 'wm_list_topics');
    expect(step?.input?.length).toBeLessThan(huge.length);
    expect(step?.input).toMatch(/truncated/);
    expect(step?.result?.length).toBeLessThan(huge.length);
    expect(step?.result).toMatch(/truncated/);
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

  test('reports missing tools and enforces the deny-list', async () => {
    // The model tries a denied tool; it must be refused, and the unavailable
    // allow-list entry must surface as missingTools.
    const bridge = new ScriptedBridge(
      [
        { text: '', toolCalls: [{ callId: '1', name: 'ws-topic-delete', input: {} }] },
        { text: 'Done.', toolCalls: [] },
      ],
      undefined,
      { available: ['ws-topic-read', 'ws-topic-delete'] },
    );
    const result = await runNanite(bridge, {
      ...BASE_OPTS,
      allowlist: ['ws-topic-read', 'ws-topic-delete', 'ws-gone'],
      denylist: ['ws-topic-delete'],
    });

    // ws-gone was requested but not available → reported as missing.
    expect(result.missingTools).toEqual(['ws-gone']);
    // ws-topic-delete was available but denied → the call is refused, not run.
    const denied = result.toolCalls.find((t) => t.name === 'ws-topic-delete');
    expect(denied?.ok).toBe(false);
    expect(denied?.error).toMatch(/not granted/);
    expect(bridge.invoked.map((i) => i.name)).not.toContain('ws-topic-delete');
  });

  test('acceptance passes when confidence >= threshold', async () => {
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }], undefined, {
      judge: {
        request_summary: 'restated request',
        response_summary: 'summarized response',
        pass: true,
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
        pass: true,
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

  // bug: confidence-vs-verdict — the judge's `confidence` is its CERTAINTY in
  // the verdict, not P(pass). A confident FAIL (pass:false, high confidence)
  // must NOT be accepted just because confidence >= threshold.
  test('a confident FAIL (pass:false, high confidence) does not pass acceptance', async () => {
    const bridge = new ScriptedBridge([{ text: 'Could not get the value.', toolCalls: [] }], undefined, {
      judge: {
        request_summary: 'get the exact value from a command',
        response_summary: 'reported it could not obtain the value',
        pass: false,
        confidence: 95,
        rationale: 'the output says the value was not obtained, so this fails',
        model: 'test-model',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });

    const result = await runNanite(bridge, { ...BASE_OPTS, acceptanceThreshold: 60 });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Acceptance Criteria Not Matched');
    expect(result.acceptance).toMatchObject({ passed: false, confidence: 95 });
  });

  test('records model + summed loop/judge token usage', async () => {
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }], undefined, {
      modelId: 'gpt-test',
      usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      judge: {
        request_summary: 'req',
        response_summary: 'res',
        pass: true,
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
    toolDenylist: [],
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
    prompt: '',
    output: '',
    missingTools: [],
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
  test('prepends a Context section with the current time (no clock tool needed)', async () => {
    const client = new FakeClient(fakeTemplate(), fakeTopic());
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }]);
    const now = new Date('2026-07-31T15:30:00.000Z');
    const runner = new ExtensionHostNaniteRunner({ client, bridge, now: () => now });

    await runner.run(fakeNanite());

    const prompt = bridge.started?.prompt ?? '';
    expect(prompt).toContain('# Context');
    expect(prompt).toContain('Current time: 2026-07-31T15:30:00.000Z');
    // Context leads the prompt, before the workstream/topic/task.
    expect(prompt.indexOf('# Context')).toBeLessThan(prompt.indexOf('# Task'));
  });

  test('reads topic body as prompt + template config, persists Running then terminal', async () => {
    const client = new FakeClient(fakeTemplate(), fakeTopic());
    const bridge = new ScriptedBridge([
      { text: '', toolCalls: [{ callId: '1', name: 'wm_create_alert', input: {} }] },
      { text: 'Done.', toolCalls: [] },
    ]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    const result = await runner.run(fakeNanite());

    expect(result.status).toBe('succeeded');
    // The runner seeded the bridge with the TEMPLATE's config (plus the
    // standard self-report directive) and a prompt carrying the workstream +
    // input topic context.
    expect(bridge.started?.instructions).toContain('Scan open topics and raise deduped alerts.');
    expect(bridge.started?.instructions).toContain('do NOT claim'); // self-report directive
    expect(bridge.started?.prompt).toContain('Do the thing described here.'); // topic body
    expect(bridge.started?.prompt).toContain('Topic A'); // topic title
    expect(bridge.started?.prompt).toContain('Peanut Harvest'); // workstream context
    expect(bridge.started?.allowlist).toEqual(['wm_create_alert']);
    // The allow-listed tool was actually invoked.
    expect(bridge.invoked.map((i) => i.name)).toEqual(['wm_create_alert']);

    // Two persistence calls: Pending→Running (begin), then the terminal
    // call carrying the result.
    expect(client.runCalls).toHaveLength(2);
    expect(client.runCalls[0]).toEqual({ id: 'n1', begin: true });
    const finish = client.runCalls[1];
    expect(finish.id).toBe('n1');
    expect(finish.outcome).toBe('succeeded');
    expect(finish.output).toBe('Done.');
    expect(finish.acceptance).toMatchObject({ passed: true, threshold: 60 });
    expect(finish.toolCalls?.map((t) => t.name)).toEqual(['wm_create_alert']);
    // The ordered execution trace is persisted alongside the flat tool-call
    // trail so the workflow can render inline with the response.
    expect(finish.steps?.map((s) => (s.kind === 'tool' ? `tool:${s.name}` : 'say'))).toEqual([
      'tool:wm_create_alert',
    ]);
  });

  test('no template → runs against the topic with empty instructions/allowlist', async () => {
    const client = new FakeClient(null, fakeTopic());
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    const result = await runner.run(fakeNanite({ templateId: null }));

    expect(result.status).toBe('succeeded');
    // No template → the only system instruction is the standard self-report
    // directive; the allow-list is empty.
    expect(bridge.started?.instructions).toContain('If you lack a tool');
    expect(bridge.started?.allowlist).toEqual([]);
    expect(bridge.started?.prompt).toContain('Do the thing described here.');
  });

  test('workstream-wide nanite (no input topic) seeds a topic INDEX, not a body', async () => {
    const topics = [
      fakeTopic({ slug: 'topic-a', title: 'Topic A', body: 'body a' }),
      fakeTopic({ slug: 'topic-b', title: 'Topic B', body: 'body b' }),
    ];
    // Template grants a topic-read tool → the index + tool-call path is used.
    const client = new FakeClient(
      fakeTemplate({ toolAllowlist: ['ws-topic-read'] }),
      null,
      topics,
    );
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

  test('workstream-wide nanite with NO topic-read tool inlines topic bodies', async () => {
    const topics = [
      fakeTopic({ slug: 'topic-a', title: 'Topic A', body: 'body a' }),
      fakeTopic({ slug: 'topic-b', title: 'Topic B', body: 'body b' }),
    ];
    // Default template grants only wm_create_alert → no way to fetch bodies, so
    // the runner inlines each topic's full content instead of promising a tool.
    const client = new FakeClient(fakeTemplate(), null, topics);
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    const result = await runner.run(fakeNanite({ inputTopic: '' }));

    expect(result.status).toBe('succeeded');
    expect(bridge.started?.prompt).toContain('# Topics in this workstream');
    // Full bodies are inlined; the tool-call invite is NOT present.
    expect(bridge.started?.prompt).toContain('body a');
    expect(bridge.started?.prompt).toContain('body b');
    expect(bridge.started?.prompt).not.toContain('ws-topic-read tool call');
  });

  test('persists missingTools on the terminal call', async () => {
    // Template requests a tool the catalog doesn't have → reported as missing.
    const client = new FakeClient(
      fakeTemplate({ toolAllowlist: ['ws-topic-read', 'ws-gone'] }),
      fakeTopic(),
    );
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }], undefined, {
      available: ['ws-topic-read'],
    });
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    await runner.run(fakeNanite());

    const finish = client.runCalls[1];
    expect(finish.missingTools).toEqual(['ws-gone']);
  });

  test('failed acceptance is persisted as a Failed terminal call', async () => {
    const client = new FakeClient(fakeTemplate(), fakeTopic());
    const bridge = new ScriptedBridge([{ text: 'Nope.', toolCalls: [] }], undefined, {
      judge: {
        request_summary: 'r',
        response_summary: 'r',
        pass: false,
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
    expect(runCalls[0]).toEqual({ id: 'n1', begin: true });
    expect(runCalls.some((c) => c.outcome === 'succeeded')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Dev-container lifecycle: the runner brings a container up before the model
// loop and tears it down after — but ONLY when the template grants run_command,
// and honoring the keep-on-failure teardown policy. No Docker required (the
// container is a fake injected via `containerFactory`).
// ---------------------------------------------------------------------------
class FakeContainer implements NaniteContainer {
  public upCalls = 0;
  public downCalls: Array<{ failed: boolean }> = [];
  public readonly execCalls: Array<{ command: string; cwd?: string }> = [];
  async up(): Promise<void> {
    this.upCalls++;
  }
  async exec(
    command: string,
    opts: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    this.execCalls.push({ command, cwd: opts.cwd });
    return { stdout: '', stderr: '', exitCode: 0 };
  }
  async down(opts: { failed: boolean }): Promise<void> {
    this.downCalls.push(opts);
  }
}

describe('ExtensionHostNaniteRunner dev container', () => {
  test('provisions a container (up → seed → down) when the template grants run_command', async () => {
    const client = new FakeClient(
      fakeTemplate({ toolAllowlist: ['run_command'] }),
      fakeTopic(),
    );
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }]);
    const container = new FakeContainer();
    const runner = new ExtensionHostNaniteRunner({
      client,
      bridge,
      containerFactory: () => container,
    });

    const result = await runner.run(fakeNanite());

    expect(result.status).toBe('succeeded');
    // Brought up exactly once, before the model loop, and passed into the seed.
    expect(container.upCalls).toBe(1);
    expect(bridge.started?.container).toBe(container);
    // Auto-removed on success (failed: false).
    expect(container.downCalls).toEqual([{ failed: false }]);
  });

  test('does NOT provision a container when the template omits run_command', async () => {
    const client = new FakeClient(fakeTemplate(), fakeTopic());
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }]);
    const container = new FakeContainer();
    const runner = new ExtensionHostNaniteRunner({
      client,
      bridge,
      containerFactory: () => container,
    });

    await runner.run(fakeNanite());

    expect(container.upCalls).toBe(0);
    expect(container.downCalls).toEqual([]);
    expect(bridge.started?.container ?? null).toBeNull();
  });

  test('keep-on-failure: a failed run tears down with failed:true', async () => {
    const client = new FakeClient(
      fakeTemplate({ toolAllowlist: ['run_command'] }),
      fakeTopic(),
    );
    const bridge = new ScriptedBridge([{ text: 'Nope.', toolCalls: [] }], undefined, {
      judge: {
        request_summary: 'r',
        response_summary: 'r',
        pass: false,
        confidence: 10,
        rationale: 'missed it',
        model: 'test-model',
        tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    const container = new FakeContainer();
    const runner = new ExtensionHostNaniteRunner({
      client,
      bridge,
      containerFactory: () => container,
    });

    const result = await runner.run(fakeNanite());

    expect(result.status).toBe('failed');
    // down() is still called on failure — the container itself enforces the
    // keep-on-failure policy from the failed flag.
    expect(container.downCalls).toEqual([{ failed: true }]);
  });

  test('a container that fails to come up fails the run (and never leaves it Running)', async () => {
    const client = new FakeClient(
      fakeTemplate({ toolAllowlist: ['run_command'] }),
      fakeTopic(),
    );
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }]);
    const container = new FakeContainer();
    container.up = async () => {
      throw new Error('docker daemon not running');
    };
    const runner = new ExtensionHostNaniteRunner({
      client,
      bridge,
      containerFactory: () => container,
    });

    const result = await runner.run(fakeNanite());

    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/docker daemon not running/);
    // The model loop never started; teardown was still attempted.
    expect(bridge.started).toBeUndefined();
    expect(container.downCalls).toEqual([{ failed: true }]);
  });
});

// ---------------------------------------------------------------------------
// Tool-name matching (allow-list ↔ VS Code's MCP-prefixed tool names)
// ---------------------------------------------------------------------------
describe('matchesToolName', () => {
  test('matches an exact name', () => {
    expect(matchesToolName('ws-topic-read', 'ws-topic-read')).toBe(true);
  });

  test('matches a VS Code MCP-prefixed name against a clean entry', () => {
    expect(matchesToolName('mcp_working-memor_ws-topic-read', 'ws-topic-read')).toBe(true);
  });

  test('does not match a different tool or a non-boundary suffix', () => {
    expect(matchesToolName('mcp_working-memor_ws-topic-create', 'ws-topic-read')).toBe(false);
    // A suffix without the `_` boundary must not match (avoids `x-topic-read`).
    expect(matchesToolName('ws-subtopic-read', 'topic-read')).toBe(false);
  });
});

describe('stripPrivilegedNaniteArgs', () => {
  test('removes approved + begin from a ws-nanite-run call (clean or prefixed)', () => {
    expect(
      stripPrivilegedNaniteArgs('ws-nanite-run', { id: 'n1', approved: true, begin: true, reset: true }),
    ).toEqual({ id: 'n1', reset: true });
    expect(
      stripPrivilegedNaniteArgs('mcp_working-memor_ws-nanite-run', { id: 'n1', approved: true }),
    ).toEqual({ id: 'n1' });
  });

  test('leaves other tools untouched', () => {
    const input = { id: 'n1', approved: true };
    expect(stripPrivilegedNaniteArgs('ws-topic-read', input)).toBe(input);
  });
});

describe('resolveToolPlan', () => {
  const available = [
    'mcp_working-memor_ws-topic-read',
    'mcp_working-memor_ws-topic-delete',
    'wm_create_alert',
  ];

  test('empty allow-list grants nothing (safe default)', () => {
    const plan = resolveToolPlan(available, [], []);
    expect(plan.granted).toEqual([]);
    expect(plan.missing).toEqual([]);
  });

  test('grants matched tools under their clean names', () => {
    const plan = resolveToolPlan(available, ['ws-topic-read', 'wm_create_alert'], []);
    expect(plan.granted).toEqual([
      { offer: 'ws-topic-read', registered: 'mcp_working-memor_ws-topic-read' },
      { offer: 'wm_create_alert', registered: 'wm_create_alert' },
    ]);
    expect(plan.missing).toEqual([]);
  });

  test('reports allow-list entries with no available match as missing', () => {
    const plan = resolveToolPlan(available, ['ws-topic-read', 'ws-nonexistent'], []);
    expect(plan.granted.map((g) => g.offer)).toEqual(['ws-topic-read']);
    expect(plan.missing).toEqual(['ws-nonexistent']);
  });

  test('deny-list subtracts from the grant (deny wins)', () => {
    const plan = resolveToolPlan(available, ['ws-topic-read', 'ws-topic-delete'], ['ws-topic-delete']);
    expect(plan.granted.map((g) => g.offer)).toEqual(['ws-topic-read']);
    // Denied ≠ missing — it was available, just blocked.
    expect(plan.missing).toEqual([]);
  });

  test('`*` grants ALL available tools, still minus the deny-list', () => {
    const plan = resolveToolPlan(available, ['*'], ['ws-topic-delete']);
    expect(plan.granted.map((g) => g.registered)).toEqual([
      'mcp_working-memor_ws-topic-read',
      'wm_create_alert',
    ]);
    expect(plan.missing).toEqual([]);
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
