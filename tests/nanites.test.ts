import { beforeEach, describe, expect, test, vi } from 'vitest';
import { openJournalStore, type JournalStore } from '../src/db';
import { AlertsStore } from '../src/alerts/store';
import { NanitesStore } from '../src/nanites/store';
import { registerNaniteTools } from '../src/nanites/tools';
import {
  runNanite,
  type NaniteConversation,
  type NaniteConversationSeed,
  type NaniteJudgeRequest,
  type NaniteJudgeResult,
  type NaniteLmBridge,
  type NaniteModelTurn,
  type NaniteTokenUsage,
} from '../src/nanites/runner';

// ---------------------------------------------------------------------------
// vscode mock — mirrors tests/alerts.test.ts so the tool-registration layer
// works without the real editor. The nanite runner itself takes no vscode
// dependency (it uses an injected bridge), so nothing else is needed.
// ---------------------------------------------------------------------------
vi.mock('vscode', () => {
  const tools = new Map<
    string,
    { invoke: (options: unknown, token?: unknown) => Promise<unknown> }
  >();
  class LanguageModelTextPart {
    constructor(public value: string) {}
  }
  class LanguageModelToolResult {
    constructor(public content: LanguageModelTextPart[]) {}
  }
  class Disposable {
    constructor(private readonly disposeFn: () => void) {}
    dispose(): void {
      this.disposeFn();
    }
  }
  return {
    lm: {
      registerTool: (
        name: string,
        impl: { invoke: (options: unknown, token?: unknown) => Promise<unknown> },
      ) => {
        tools.set(name, impl);
        return new Disposable(() => tools.delete(name));
      },
    },
    LanguageModelTextPart,
    LanguageModelToolResult,
    Disposable,
    __getRegisteredTool: (name: string) => tools.get(name),
    __clearRegisteredTools: () => tools.clear(),
  };
});

function freshStore(): {
  store: JournalStore;
  nanites: NanitesStore;
  alerts: AlertsStore;
} {
  const store = openJournalStore({ dbPath: ':memory:' });
  return {
    store,
    nanites: new NanitesStore(store.connection),
    alerts: new AlertsStore(store.connection),
  };
}

const BASE_NANITE = {
  slug: 'flag-followups-reminders',
  title: 'Flag followups and reminders',
  trigger_phrase: 'Flag followups and reminders',
  instructions: 'Scan open topics and raise deduped alerts.',
  acceptance_criteria: 'Every open followup topic is flagged with a deduped alert.',
  tool_allowlist: ['wm_list_topics', 'wm_get_topic', 'wm_list_alerts', 'wm_create_alert'],
};

// ---------------------------------------------------------------------------
// Scripted fake bridge: deterministic stand-in for the vscode.lm loop.
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

beforeEach(async () => {
  const vscode = await import('vscode');
  (
    vscode as unknown as { __clearRegisteredTools: () => void }
  ).__clearRegisteredTools();
});

// ---------------------------------------------------------------------------
// Store CRUD
// ---------------------------------------------------------------------------
describe('NanitesStore CRUD', () => {
  test('createNanite: inserts with defaults and parses allowlist', () => {
    const { nanites } = freshStore();
    const n = nanites.createNanite(BASE_NANITE);
    expect(n.id).toBeGreaterThan(0);
    expect(n.slug).toBe('flag-followups-reminders');
    expect(n.kind).toBe('nanite');
    expect(n.enabled).toBe(true);
    expect(n.model).toBeNull();
    expect(n.tool_allowlist).toEqual(BASE_NANITE.tool_allowlist);
  });

  test('createNanite: rejects missing slug / instructions / acceptance_criteria', () => {
    const { nanites } = freshStore();
    expect(() =>
      nanites.createNanite({ slug: '', instructions: 'x', acceptance_criteria: 'c' }),
    ).toThrow(/slug is required/);
    expect(() =>
      nanites.createNanite({ slug: 'x', instructions: '  ', acceptance_criteria: 'c' }),
    ).toThrow(/instructions are required/);
    expect(() =>
      nanites.createNanite({ slug: 'y', instructions: 'x', acceptance_criteria: '   ' }),
    ).toThrow(/acceptance_criteria is required/);
  });

  test('createNanite: duplicate slug rejected', () => {
    const { nanites } = freshStore();
    nanites.createNanite(BASE_NANITE);
    expect(() => nanites.createNanite(BASE_NANITE)).toThrow(/already exists/);
  });

  test('listNanites: enabled-only by default, include_disabled widens', () => {
    const { nanites } = freshStore();
    nanites.createNanite(BASE_NANITE);
    nanites.createNanite({
      slug: 'disabled-one',
      instructions: 'x',
      acceptance_criteria: 'c',
      enabled: false,
    });
    expect(nanites.listNanites().map((n) => n.slug)).toEqual([
      'flag-followups-reminders',
    ]);
    expect(
      nanites.listNanites({ include_disabled: true }).map((n) => n.slug).sort(),
    ).toEqual(['disabled-one', 'flag-followups-reminders']);
  });

  test('getNaniteBySlug: null for unknown', () => {
    const { nanites } = freshStore();
    expect(nanites.getNaniteBySlug('nope')).toBeNull();
  });

  test('deleteNanite: soft-deletes, hides from default list, include_deleted reveals', () => {
    const { nanites } = freshStore();
    nanites.createNanite(BASE_NANITE);

    const res = nanites.deleteNanite(BASE_NANITE.slug);
    expect(res.nanites).toBe(1);

    // Hidden from the default (and include_disabled) list…
    expect(nanites.listNanites()).toHaveLength(0);
    expect(nanites.listNanites({ include_disabled: true })).toHaveLength(0);
    // …but revealed with include_deleted, carrying a deleted_at stamp.
    const deleted = nanites.listNanites({ include_deleted: true });
    expect(deleted.map((n) => n.slug)).toEqual([BASE_NANITE.slug]);
    expect(deleted[0].deleted_at).not.toBeNull();

    // getNaniteBySlug hides it by default, surfaces it with includeDeleted.
    expect(nanites.getNaniteBySlug(BASE_NANITE.slug)).toBeNull();
    expect(nanites.getNaniteBySlug(BASE_NANITE.slug, true)?.deleted_at).not.toBeNull();
  });

  test('deleteNanite: idempotent no-op when already deleted; throws when unknown', () => {
    const { nanites } = freshStore();
    nanites.createNanite(BASE_NANITE);
    expect(nanites.deleteNanite(BASE_NANITE.slug).nanites).toBe(1);
    // Second delete is a no-op, not an error.
    expect(nanites.deleteNanite(BASE_NANITE.slug).nanites).toBe(0);
    expect(() => nanites.deleteNanite('no-such-nanite')).toThrow(/nanite not found/i);
  });

  test('restoreNanite: un-hides a soft-deleted nanite', () => {
    const { nanites } = freshStore();
    nanites.createNanite(BASE_NANITE);
    nanites.deleteNanite(BASE_NANITE.slug);

    const res = nanites.restoreNanite(BASE_NANITE.slug);
    expect(res.nanites).toBe(1);

    // Back in the default list with a cleared deleted_at.
    expect(nanites.listNanites().map((n) => n.slug)).toEqual([BASE_NANITE.slug]);
    expect(nanites.getNaniteBySlug(BASE_NANITE.slug)?.deleted_at).toBeNull();
  });

  test('restoreNanite: idempotent no-op when active; throws when unknown', () => {
    const { nanites } = freshStore();
    nanites.createNanite(BASE_NANITE);
    // Already active → no-op.
    expect(nanites.restoreNanite(BASE_NANITE.slug).nanites).toBe(0);
    expect(() => nanites.restoreNanite('no-such-nanite')).toThrow(/nanite not found/i);
  });

  test('run audit trail: start + finish records a row', () => {
    const { nanites } = freshStore();
    const n = nanites.createNanite(BASE_NANITE);
    const runId = nanites.startRun(n.id);
    const running = nanites.getRun(runId);
    expect(running?.status).toBe('running');
    nanites.finishRun(runId, 'succeeded', { summary: 'ok' }, null);
    const done = nanites.getRun(runId);
    expect(done?.status).toBe('succeeded');
    expect(done?.result).toEqual({ summary: 'ok' });
    expect(nanites.listRuns(n.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------
describe('nanite tools', () => {
  test('registers the seven wm_*nanite tools', () => {
    const { nanites } = freshStore();
    const subs = registerNaniteTools(nanites, {
      refresh: () => {},
      bridge: new ScriptedBridge([]),
    });
    expect(subs).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Runner loop
// ---------------------------------------------------------------------------
describe('runNanite', () => {
  test('drives the tool-calling loop, enforces the allow-list, records a run', async () => {
    const { store, nanites } = freshStore();
    store.createTopic({ slug: 'topic-a' });
    const n = nanites.createNanite({
      ...BASE_NANITE,
      tool_allowlist: ['wm_list_topics', 'wm_create_alert'],
    });

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

    const result = await runNanite(nanites, bridge, { slug: n.slug });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(result.iterations).toBe(3);
    // The verbatim final text is nested under response.output now.
    expect(result.response?.output).toBe('Done: flagged 1 topic.');
    // No top-level output on the result — it lives on response.output now.
    expect((result as Record<string, unknown>).output).toBeUndefined();
    // Prompt defaults to the trigger phrase and is now nested under request.
    expect(result.request?.prompt).toBe(BASE_NANITE.trigger_phrase);
    // No top-level prompt on the result — it lives on request.prompt now.
    expect((result as Record<string, unknown>).prompt).toBeUndefined();
    // The three structured summary fields are present.
    expect(result.request?.summary).toBeTruthy();
    expect(result.response?.summary).toBeTruthy();
    expect(result.acceptance?.summary).toBeTruthy();
    // The judge was handed the full tool-call trail (name + ok + optional error).
    expect(bridge.judged?.toolCalls).toEqual(result.tool_calls);
    expect(bridge.judged?.toolCalls.map((t) => t.name)).toEqual([
      'wm_list_topics',
      'wm_create_alert',
      'wm_delete_topic',
    ]);
    // The raw final text is persisted under `response.output` (not top-level).
    const persisted = nanites.getRun(result.run_id)?.result as Record<
      string,
      unknown
    >;
    expect((persisted.response as Record<string, unknown>).output).toBe(
      'Done: flagged 1 topic.',
    );
    expect(persisted.output).toBeUndefined();
    expect(persisted.summary).toBeUndefined();
    // Prompt is nested under request; no top-level prompt on the persisted blob.
    expect(persisted.prompt).toBeUndefined();
    expect((persisted.request as Record<string, unknown>).prompt).toBe(
      BASE_NANITE.trigger_phrase,
    );
    expect((persisted.response as Record<string, unknown>).summary).toBeTruthy();
    // Allow-listed calls dispatched; the forbidden one was refused, not invoked.
    expect(bridge.invoked.map((i) => i.name)).toEqual([
      'wm_list_topics',
      'wm_create_alert',
    ]);
    const forbidden = result.tool_calls.find((t) => t.name === 'wm_delete_topic');
    expect(forbidden?.ok).toBe(false);
    expect(forbidden?.error).toMatch(/allow-list/);

    const run = nanites.getRun(result.run_id);
    expect(run?.status).toBe('succeeded');
  });

  test('unknown / disabled nanite', async () => {
    const { nanites } = freshStore();
    const bridge = new ScriptedBridge([]);
    await expect(runNanite(nanites, bridge, { slug: 'nope' })).rejects.toThrow(
      /not found/,
    );
    nanites.createNanite({
      slug: 'off',
      instructions: 'x',
      acceptance_criteria: 'c',
      enabled: false,
    });
    await expect(runNanite(nanites, bridge, { slug: 'off' })).rejects.toThrow(
      /disabled/,
    );
  });

  test('running twice is idempotent via the alerts dedupe key', async () => {
    const { store, nanites, alerts } = freshStore();
    store.createTopic({ slug: 'topic-a' });
    const n = nanites.createNanite(BASE_NANITE);

    // The handler routes wm_create_alert into the real AlertsStore, exactly as
    // the production wm_create_alert tool would.
    const handler = (name: string, input: unknown): string => {
      if (name === 'wm_create_alert') {
        const res = alerts.createAlert(input as never);
        return JSON.stringify({ ok: true, ...res });
      }
      return JSON.stringify({ ok: true });
    };
    const script = (): NaniteModelTurn[] => [
      {
        text: '',
        toolCalls: [
          {
            callId: '1',
            name: 'wm_create_alert',
            input: {
              description: 'topic-a has a followup: ping Alex',
              recommended_action: 'Follow up with Alex',
              topic_slugs: ['topic-a'],
              created_by: 'flag-followups-reminders',
              dedupe_key: 'flag-followups-reminders:topic-a:followup',
            },
          },
        ],
      },
      { text: 'Flagged 1 topic.', toolCalls: [] },
    ];

    const first = await runNanite(nanites, new ScriptedBridge(script(), handler), {
      slug: n.slug,
    });
    const second = await runNanite(nanites, new ScriptedBridge(script(), handler), {
      slug: n.slug,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    // Second run upserted the same alert — still exactly one on the topic.
    expect(alerts.listAlerts({ topic_slug: 'topic-a' })).toHaveLength(1);
    // Two runs recorded in the audit trail.
    expect(nanites.listRuns(n.id)).toHaveLength(2);
  });

  test('records model + summed loop/judge token usage on the result', async () => {
    const { nanites } = freshStore();
    const n = nanites.createNanite(BASE_NANITE);
    const bridge = new ScriptedBridge(
      [{ text: 'Done.', toolCalls: [] }],
      undefined,
      {
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
      },
    );

    const result = await runNanite(nanites, bridge, { slug: n.slug });

    expect(result.ok).toBe(true);
    expect(result.model).toBe('gpt-test');
    // Loop (10/5) + judge (3/2) folded together.
    expect(result.input_tokens).toBe(13);
    expect(result.output_tokens).toBe(7);
    expect(result.total_tokens).toBe(20);

    // The same block is persisted on the run row.
    const run = nanites.getRun(result.run_id);
    const persisted = run?.result as Record<string, unknown>;
    expect(persisted.model).toBe('gpt-test');
    expect(persisted.total_tokens).toBe(20);
  });

  test('acceptance passes when confidence >= threshold', async () => {
    const { nanites } = freshStore();
    const n = nanites.createNanite({ ...BASE_NANITE, acceptance_threshold: 60 });
    const bridge = new ScriptedBridge(
      [{ text: 'Done.', toolCalls: [] }],
      undefined,
      {
        judge: {
          request_summary: 'restated request',
          response_summary: 'summarized response',
          confidence: 75,
          rationale: 'clears the bar',
          model: 'test-model',
          tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    );

    const result = await runNanite(nanites, bridge, { slug: n.slug });

    expect(result.ok).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(result.error).toBeUndefined();
    expect(result.acceptance).toMatchObject({
      summary: 'clears the bar',
      confidence: 75,
      threshold: 60,
      passed: true,
    });
    // The restructured request/response summaries land on the result.
    expect(result.request?.summary).toBe('restated request');
    expect(result.response?.summary).toBe('summarized response');
    // The judge saw the nanite's criteria, prompt, and the final output.
    expect(bridge.judged?.criteria).toBe(BASE_NANITE.acceptance_criteria);
    expect(bridge.judged?.prompt).toBe(BASE_NANITE.trigger_phrase);
    expect(bridge.judged?.output).toBe('Done.');
  });

  test('acceptance fails below threshold → "Acceptance Criteria Not Matched"', async () => {
    const { nanites } = freshStore();
    const n = nanites.createNanite({ ...BASE_NANITE, acceptance_threshold: 60 });
    const bridge = new ScriptedBridge(
      [{ text: 'Half done.', toolCalls: [] }],
      undefined,
      {
        judge: {
          request_summary: 'restated request',
          response_summary: 'only half done',
          confidence: 40,
          rationale: 'missed two topics',
          model: 'test-model',
          tokens: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    );

    const result = await runNanite(nanites, bridge, { slug: n.slug });

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toBe('Acceptance Criteria Not Matched');
    expect(result.acceptance).toMatchObject({
      summary: 'missed two topics',
      confidence: 40,
      threshold: 60,
      passed: false,
    });
    expect(result.request?.summary).toBe('restated request');
    expect(result.response?.summary).toBe('only half done');

    // The run row is failed but still carries the full request/response/acceptance.
    const run = nanites.getRun(result.run_id);
    expect(run?.status).toBe('failed');
    expect(run?.error).toBe('Acceptance Criteria Not Matched');
    const persisted = run?.result as Record<string, unknown>;
    expect((persisted.acceptance as Record<string, unknown>).passed).toBe(false);
    expect((persisted.request as Record<string, unknown>).summary).toBe(
      'restated request',
    );
    expect((persisted.response as Record<string, unknown>).summary).toBe(
      'only half done',
    );
    expect(persisted.prompt).toBeUndefined();
    expect((persisted.request as Record<string, unknown>).prompt).toBe(
      BASE_NANITE.trigger_phrase,
    );
  });
});
