import { describe, expect, test } from 'vitest';
import { runNanite } from '../src/nanites/runner';
import {
  ExtensionHostNaniteRunner,
  resolveRunLimits,
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
  Config,
  Nanite,
  NaniteJournal,
  NaniteJournalCreateInput,
  NaniteRunInput,
  NaniteTemplate,
  Topic,
  Workstream,
} from '../src/controlPlaneClient';
import type { CommandJournalSpec } from '../src/commandJournal';
import type { WriteDocumentResult } from '../src/controlPlaneClient';

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

  test('tags every step with the model-turn (round) index across turns', async () => {
    const bridge = new ScriptedBridge(
      [
        {
          text: 'Round one narration.',
          toolCalls: [{ callId: '1', name: 'wm_list_topics', input: {} }],
        },
        {
          text: 'Round two narration.',
          toolCalls: [
            { callId: '2', name: 'wm_create_alert', input: {} },
            { callId: '3', name: 'wm_list_topics', input: {} },
          ],
        },
        { text: 'Done.', toolCalls: [] },
      ],
      (name) => JSON.stringify({ ok: true, tool: name }),
    );

    const result = await runNanite(bridge, {
      ...BASE_OPTS,
      allowlist: ['wm_list_topics', 'wm_create_alert'],
    });

    // Round 1: narration + its single tool. Round 2: narration + two tools.
    // The final (tool-less) turn is NOT recorded as a step.
    expect(result.steps.map((s) => ({ kind: s.kind, round: s.round }))).toEqual([
      { kind: 'assistant', round: 1 },
      { kind: 'tool', round: 1 },
      { kind: 'assistant', round: 2 },
      { kind: 'tool', round: 2 },
      { kind: 'tool', round: 2 },
    ]);
    // The round index is monotonically non-decreasing in trace order.
    const rounds = result.steps.map((s) => s.round ?? 0);
    for (let i = 1; i < rounds.length; i++) {
      expect(rounds[i]).toBeGreaterThanOrEqual(rounds[i - 1]);
    }
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

  // bug: friendly-step-list-read-rendering — a WM read whose bodies are huge
  // truncates `result` into invalid JSON, so the friendly rendering can't parse
  // it. The runner must capture a body-free digest from the FULL result first.
  test('captures a body-free resultDigest for a WM read even when result is truncated', async () => {
    const longBody = 'lorem ipsum dolor sit amet '.repeat(200);
    const readResult = JSON.stringify({
      count: 2,
      topics: [
        { id: 't-1', slug: 'topic-a', title: 'Topic A', body: longBody, resourceVersion: 5 },
        { id: 't-2', slug: 'topic-b', title: 'Topic B', body: longBody, resourceVersion: 6 },
      ],
    });
    const bridge = new ScriptedBridge(
      [
        { text: '', toolCalls: [{ callId: '1', name: 'ws-topic-read', input: { workstream: 'wf' } }] },
        { text: 'Done.', toolCalls: [] },
      ],
      () => readResult,
    );

    const result = await runNanite(bridge, { ...BASE_OPTS, allowlist: ['ws-topic-read'] });

    const step = result.steps.find((s) => s.name === 'ws-topic-read');
    // The raw result preview is truncated (invalid JSON) — proving the digest
    // is the only reliable render source.
    expect(step?.result?.length).toBeLessThan(readResult.length);
    expect(step?.result).toMatch(/truncated/);
    // The digest carries the TRUE count and body-free identity items only.
    expect(step?.resultDigest?.count).toBe(2);
    expect(step?.resultDigest?.items).toEqual([
      { id: 't-1', slug: 'topic-a', title: 'Topic A', resourceVersion: 5 },
      { id: 't-2', slug: 'topic-b', title: 'Topic B', resourceVersion: 6 },
    ]);
    for (const item of step!.resultDigest!.items) {
      expect(item).not.toHaveProperty('body');
    }
  });

  test('does not attach a resultDigest for a non-WM-read tool', async () => {
    const bridge = new ScriptedBridge(
      [
        { text: '', toolCalls: [{ callId: '1', name: 'wm_list_topics', input: {} }] },
        { text: 'Done.', toolCalls: [] },
      ],
      () => JSON.stringify({ count: 1, topics: [{ id: 'x', slug: 'x', resourceVersion: 1 }] }),
    );
    const result = await runNanite(bridge, { ...BASE_OPTS, allowlist: ['wm_list_topics'] });
    const step = result.steps.find((s) => s.name === 'wm_list_topics');
    expect(step?.resultDigest).toBeUndefined();
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
    configs: [],
    request: '',
    phase: 'Pending',
    queuedAt: null,
    startedAt: null,
    endedAt: null,
    error: '',
    latestJournalId: null,
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
  public readonly journalCalls: CommandJournalSpec[] = [];
  public readonly journalCreateCalls: NaniteJournalCreateInput[] = [];
  constructor(
    private readonly template: NaniteTemplate | null,
    private readonly topic: Topic | null,
    private readonly workstreamTopics: Topic[] = [],
    private readonly configs: Record<string, Record<string, string>> = {},
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
  async configRead(input: { slug?: string; id?: string }): Promise<Config[]> {
    const key = input.slug ?? input.id;
    const data = key !== undefined ? this.configs[key] : undefined;
    if (!data) {
      return [];
    }
    return [
      {
        id: `cfg-${key}`,
        slug: input.slug ?? null,
        name: '',
        data,
        status: '',
        created_at: 0,
        updated_at: 0,
        resourceVersion: 1,
      },
    ];
  }
  async naniteRun(input: NaniteRunInput): Promise<Nanite> {
    this.runCalls.push(input);
    return fakeNanite();
  }
  async naniteJournalCreate(input: NaniteJournalCreateInput): Promise<NaniteJournal> {
    this.journalCreateCalls.push(input);
    const id = `njournal-${this.journalCreateCalls.length}`;
    return {
      id,
      slug: null,
      naniteId: input.naniteId,
      workstream: input.workstream ?? '',
      inputTopic: input.inputTopic ?? '',
      status: {
        phase: input.status?.phase ?? 'Succeeded',
        outcome: input.status?.outcome ?? 'succeeded',
        queuedAt: input.status?.queuedAt ?? null,
        startedAt: input.status?.startedAt ?? null,
        endedAt: input.status?.endedAt ?? null,
      },
      prompt: { request: input.prompt?.request ?? '' },
      execution: { steps: input.execution?.steps ?? [], error: input.execution?.error ?? '' },
      results: {
        summary: input.results?.summary ?? '',
        acceptance: input.results?.acceptance ?? null,
        tokens: input.results?.tokens ?? null,
        missingTools: input.results?.missingTools ?? [],
      },
      created_at: 0,
      updated_at: 0,
      resourceVersion: 1,
    };
  }
  async commandJournalCreate(spec: CommandJournalSpec): Promise<WriteDocumentResult> {
    this.journalCalls.push(spec);
    return {
      available: true,
      document: {
        kind: 'CommandJournal',
        metadata: {
          id: `journal-${this.journalCalls.length}`,
          slug: null,
          labels: {},
          createdAt: 0,
          updatedAt: 0,
          deletedAt: null,
          resourceVersion: 1,
        },
        spec: spec as unknown as Record<string, unknown>,
        status: {},
      },
    };
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

  test('posts completion turns to the nanite session AND the input topic', async () => {
    const client = new FakeClient(fakeTemplate(), fakeTopic());
    const bridge = new ScriptedBridge([{ text: 'All done.', toolCalls: [] }]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    await runner.run(fakeNanite({ inputTopic: 'topic-a', workstream: 'ws' }));

    // Two posts: the nanite's OWN session (scope = its id, contextKind
    // 'nanite') FIRST — the mandatory channel a focused nanite doc replays —
    // then the input topic so the ticket carries the outcome too.
    expect(client.journalCalls).toHaveLength(2);
    const [session, ticket] = client.journalCalls;
    expect(session.workstream).toBe('n1');
    expect(session.request.contextKind).toBe('nanite');
    expect(session.status).toBe('succeeded');
    expect(session.response.brief).toContain('Nanite succeeded');
    expect(ticket.workstream).toBe('topic-a');
    expect(ticket.request.contextKind).toBe('topic');
    // The chat post happens AFTER the terminal persist, never before.
    expect(client.runCalls.at(-1)?.outcome).toBe('succeeded');
  });

  test('workstream-wide run posts to the nanite session AND the workstream', async () => {
    const client = new FakeClient(fakeTemplate(), null);
    const bridge = new ScriptedBridge([{ text: 'All done.', toolCalls: [] }]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    // No input topic → the ticket scope falls back to the workstream.
    await runner.run(fakeNanite({ inputTopic: '', workstream: 'ws' }));

    expect(client.journalCalls).toHaveLength(2);
    const [session, ticket] = client.journalCalls;
    expect(session.workstream).toBe('n1');
    expect(session.request.contextKind).toBe('nanite');
    expect(ticket.workstream).toBe('ws');
    expect(ticket.request.contextKind).toBe('workstream');
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
    // standard self-report directive) and a prompt carrying the input topic
    // context. The workstream section is no longer inlined.
    expect(bridge.started?.instructions).toContain('Scan open topics and raise deduped alerts.');
    expect(bridge.started?.instructions).toContain('do NOT claim'); // self-report directive
    expect(bridge.started?.prompt).toContain('Do the thing described here.'); // topic body
    expect(bridge.started?.prompt).toContain('Topic A'); // topic title
    expect(bridge.started?.prompt).not.toContain('# Workstream'); // no inline workstream
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
    // The run RESULT lives in the immutable NaniteJournal record; the terminal
    // call carries only a light pointer to it, never the result itself.
    expect(finish.latestJournalId).toBe('njournal-1');
    const journal = client.journalCreateCalls[0];
    expect(journal.results?.summary).toBe('Done.');
    expect(journal.results?.acceptance).toMatchObject({ passed: true, threshold: 60 });
    // The ordered execution trace is the persisted tool trail — each tool step
    // (with its name + ok/error) lands in `execution.steps`; there is no longer
    // a redundant `results.toolCalls`.
    expect(
      journal.execution?.steps?.map((s) => (s.kind === 'tool' ? `tool:${s.name}` : 'say')),
    ).toEqual(['tool:wm_create_alert']);
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

  test('workstream-wide nanite (no input topic) seeds a terse tool pointer, no inline topics', async () => {
    const topics = [
      fakeTopic({ slug: 'topic-a', title: 'Topic A', body: 'body a' }),
      fakeTopic({ slug: 'topic-b', title: 'Topic B', body: 'body b' }),
    ];
    // Even with a topic-read tool granted, no topic data is inlined — the
    // prompt just points the model at the discovery tools.
    const client = new FakeClient(
      fakeTemplate({ toolAllowlist: ['ws-topic-read'] }),
      null,
      topics,
    );
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }]);
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    const result = await runner.run(fakeNanite({ inputTopic: '' }));

    expect(result.status).toBe('succeeded');
    // The prompt tells the model this is a workstream-wide run and to use the
    // discovery tools — it does NOT list topics or inline any content.
    expect(bridge.started?.prompt).toContain('# Input topics');
    expect(bridge.started?.prompt).toContain('This Nanite runs workstream-wide');
    expect(bridge.started?.prompt).toContain('ws-workstream-read and ws-topic-read');
    expect(bridge.started?.prompt).not.toContain('# Topics in this workstream');
    expect(bridge.started?.prompt).not.toContain('Topic A');
    expect(bridge.started?.prompt).not.toContain('body a');
    expect(bridge.started?.prompt).not.toContain('# Input topic\n');
    // The workstream section is no longer emitted.
    expect(bridge.started?.prompt).not.toContain('# Workstream');
    expect(bridge.started?.prompt).not.toContain('Peanut Harvest');
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

    // missingTools is part of the run result → persisted on the journal record.
    expect(client.journalCreateCalls[0].results?.missingTools).toEqual(['ws-gone']);
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
    // The acceptance verdict is part of the run result → journal record.
    expect(client.journalCreateCalls[0].results?.acceptance).toMatchObject({ passed: false });
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
      // The workstream read hangs forever.
      wsRead: async () => HANG<Workstream[]>(),
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
    expect(result.error).toMatch(/read workstream timed out/);
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
// loop — but ONLY when the template grants run_command — and deliberately does
// NOT tear it down afterward. The container persists past the run (success or
// failure) so a served app stays reachable; cleanup is manual. No Docker
// required (the container is a fake injected via `containerFactory`).
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
  test('provisions a container (up → seed) but never tears it down when the template grants run_command', async () => {
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
    // The container persists past the run — the runner never tears it down.
    expect(container.downCalls).toEqual([]);
  });

  test('resolves nanite.configs into merged container env (later config wins) and skips a missing config', async () => {
    const client = new FakeClient(
      fakeTemplate({ toolAllowlist: ['run_command'] }),
      fakeTopic(),
      [],
      {
        'cfg-a': { SHARED: 'from-a', ONLY_A: 'a' },
        'cfg-b': { SHARED: 'from-b', ONLY_B: 'b' },
      },
    );
    const bridge = new ScriptedBridge([{ text: 'Done.', toolCalls: [] }]);
    const container = new FakeContainer();
    let capturedEnv: Record<string, string> | undefined;
    const warnings: string[] = [];
    const runner = new ExtensionHostNaniteRunner({
      client,
      bridge,
      containerFactory: (_n, env) => {
        capturedEnv = env;
        return container;
      },
      log: (m) => warnings.push(m),
    });

    const result = await runner.run(
      fakeNanite({ configs: ['cfg-a', 'cfg-b', 'cfg-missing'] }),
    );

    expect(result.status).toBe('succeeded');
    // Later config wins on a key collision; both configs' unique keys survive.
    expect(capturedEnv).toEqual({ SHARED: 'from-b', ONLY_A: 'a', ONLY_B: 'b' });
    // The missing config is skipped best-effort, with a warning — not a failure.
    expect(warnings.join('\n')).toMatch(/cfg-missing/);
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

  test('a failed run leaves the container running (no teardown)', async () => {
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
    // The container persists even on failure — the runner never tears it down.
    expect(container.downCalls).toEqual([]);
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
    // The model loop never started; the container is never torn down.
    expect(bridge.started).toBeUndefined();
    expect(container.downCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Configurable per-run caps: resolveRunLimits (pure) + threading integration
// ---------------------------------------------------------------------------
describe('resolveRunLimits (per-run caps)', () => {
  test('tool-only template with empty executionSettings → 12 rounds / 120s', () => {
    expect(resolveRunLimits(fakeTemplate())).toEqual({
      maxIterations: 12,
      timeoutMs: 120_000,
    });
  });

  test('container-granting template with empty executionSettings → 40 rounds / 900s', () => {
    const tpl = fakeTemplate({ toolAllowlist: ['run_command'] });
    expect(resolveRunLimits(tpl)).toEqual({ maxIterations: 40, timeoutMs: 900_000 });
  });

  test('a wildcard allow-list counts as container-backed (roomier defaults)', () => {
    const tpl = fakeTemplate({ toolAllowlist: ['*'] });
    expect(resolveRunLimits(tpl)).toEqual({ maxIterations: 40, timeoutMs: 900_000 });
  });

  test('run_command on the deny-list falls back to tool-only defaults', () => {
    const tpl = fakeTemplate({ toolAllowlist: ['*'], toolDenylist: ['run_command'] });
    expect(resolveRunLimits(tpl)).toEqual({ maxIterations: 12, timeoutMs: 120_000 });
  });

  test('explicit executionSettings override the type defaults (after clamping)', () => {
    const tpl = fakeTemplate({
      toolAllowlist: ['run_command'],
      executionSettings: { maxIterations: 5, runTimeoutSeconds: 60 },
    });
    expect(resolveRunLimits(tpl)).toEqual({ maxIterations: 5, timeoutMs: 60_000 });
  });

  test('out-of-range values clamp to bounds (rounds [1,200], timeout [30,3600]s)', () => {
    const tooBig = fakeTemplate({
      executionSettings: { maxIterations: 9999, runTimeoutSeconds: 100_000 },
    });
    expect(resolveRunLimits(tooBig)).toEqual({ maxIterations: 200, timeoutMs: 3_600_000 });

    const tooSmall = fakeTemplate({
      executionSettings: { maxIterations: 0, runTimeoutSeconds: 5 },
    });
    expect(resolveRunLimits(tooSmall)).toEqual({ maxIterations: 1, timeoutMs: 30_000 });
  });

  test('fractional values round to an integer before clamping', () => {
    const tpl = fakeTemplate({
      executionSettings: { maxIterations: 7.8, runTimeoutSeconds: 45.4 },
    });
    expect(resolveRunLimits(tpl)).toEqual({ maxIterations: 8, timeoutMs: 45_000 });
  });

  test('foreign / non-number / absent executionSettings fall back to type defaults', () => {
    const foreign = fakeTemplate({
      toolAllowlist: ['run_command'],
      executionSettings: { maxIterations: 'lots', runTimeoutSeconds: null, model: 'gpt' },
    });
    expect(resolveRunLimits(foreign)).toEqual({ maxIterations: 40, timeoutMs: 900_000 });

    // A null template resolves to tool-only defaults (no run_command grant).
    expect(resolveRunLimits(null)).toEqual({ maxIterations: 12, timeoutMs: 120_000 });
  });

  test('NaN / Infinity are treated as absent (not clamped) → type default', () => {
    const tpl = fakeTemplate({
      executionSettings: { maxIterations: Number.POSITIVE_INFINITY, runTimeoutSeconds: NaN },
    });
    expect(resolveRunLimits(tpl)).toEqual({ maxIterations: 12, timeoutMs: 120_000 });
  });
});

describe('ExtensionHostNaniteRunner run-cap threading', () => {
  // A conversation that always asks for a granted tool never completes, so the
  // loop runs until it hits the resolved round cap — a proxy for the resolved
  // maxIterations threaded into runNanite.
  function alwaysToolTurns(count: number) {
    return Array.from({ length: count }, () => ({
      text: '',
      toolCalls: [{ callId: 'c', name: 'wm_create_alert', input: {} }],
    }));
  }

  test('executionSettings.maxIterations override is threaded into the run loop', async () => {
    const client = new FakeClient(
      fakeTemplate({ executionSettings: { maxIterations: 5, runTimeoutSeconds: 60 } }),
      fakeTopic(),
    );
    const bridge = new ScriptedBridge(alwaysToolTurns(20));
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    const result = await runner.run(fakeNanite());

    expect(result.iterations).toBe(5);
    expect(result.hitIterationCap).toBe(true);
  });

  test('tool-only default (12) is threaded when executionSettings is empty', async () => {
    const client = new FakeClient(fakeTemplate(), fakeTopic());
    const bridge = new ScriptedBridge(alwaysToolTurns(30));
    const runner = new ExtensionHostNaniteRunner({ client, bridge });

    const result = await runner.run(fakeNanite());

    expect(result.iterations).toBe(12);
    expect(result.hitIterationCap).toBe(true);
  });

  test('explicit deps.maxIterations still overrides the resolved cap', async () => {
    const client = new FakeClient(
      fakeTemplate({ executionSettings: { maxIterations: 40 } }),
      fakeTopic(),
    );
    const bridge = new ScriptedBridge(alwaysToolTurns(20));
    const runner = new ExtensionHostNaniteRunner({ client, bridge, maxIterations: 2 });

    const result = await runner.run(fakeNanite());

    expect(result.iterations).toBe(2);
    expect(result.hitIterationCap).toBe(true);
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
