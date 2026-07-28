/**
 * Working Memory "Capture" chat-session provider (workstream-scoped).
 *
 * Registers a Working Memory session TYPE (via the proposed `chatSessionsProvider`
 * API). You select a workstream (natural language: "work on <name>", or the
 * bottom picker); that becomes "this workstream". Its associated documents
 * (control-plane topics whose membership includes the workstream) are loaded as
 * context, and every item you send is processed grounded in that context.
 *
 * Self-contained: the only outside touch points are `activate()` calling
 * {@link registerCaptureChatSession} and the `chatSessions` /
 * `enabledApiProposals` manifest additions. Everything degrades to a no-op when
 * the proposed API is unavailable (i.e. not launched with
 * `--enable-proposed-api`).
 */

import * as vscode from 'vscode';
import type { JournalStore } from '../db';
import type { ControlPlaneClient, Topic as CpTopic } from '../controlPlaneClient';

/** Session type id (matches `contributes.chatSessions[].type` in package.json). */
const SESSION_TYPE = 'working-memory-capture';
/**
 * URI scheme owned by the content provider. This MUST equal {@link SESSION_TYPE}:
 * VS Code derives a session's type from its custom URI scheme (see `Qc()` in the
 * extension host — for a non-local scheme the session type *is* the scheme). If
 * the scheme differs from the registered controller/type, selecting the agent in
 * the picker fails to resolve a content provider and the selection reverts.
 */
const SCHEME = SESSION_TYPE;
/** Preferred lightweight model families, tried in order. */
const MODEL_FAMILIES = ['gpt-4o-mini', 'gpt-4o'];

/** Option-group id for the active-workstream picker shown at the chat bottom. */
const WORKSTREAM_GROUP_ID = 'workstream';
/** Number of color slots — mirrors media/panel/panel.js `colorIndexForId % 15`. */
const WS_COLOR_SLOTS = 15;

/** Natural-language triggers that switch the active workstream. */
const WORK_ON_RE =
  /^\s*(?:let'?s\s+)?(?:work(?:ing)?\s+on|switch\s+to|focus\s+on|move\s+to|go\s+to)\s+(.+?)\s*$/i;

/** Per-chat-session state: which workstream is active + the live bottom pill. */
interface SessionState {
  /** Slug of the active workstream. `null` until the user selects one. */
  activeSlug: string | null;
  /** The live input state whose option group renders the bottom pill. */
  inputState?: vscode.ChatSessionInputState;
}

/**
 * Wire up the capture session type. No-op (with a console note) when the
 * proposed API isn't present, so it never breaks activation.
 */
export function registerCaptureChatSession(
  context: vscode.ExtensionContext,
  store: JournalStore,
  cp: ControlPlaneClient | null,
): void {
  const chatApi = vscode.chat as unknown as {
    createChatSessionItemController?: unknown;
    registerChatSessionContentProvider?: unknown;
  };
  if (
    typeof chatApi.createChatSessionItemController !== 'function' ||
    typeof chatApi.registerChatSessionContentProvider !== 'function'
  ) {
    console.warn(
      '[working-memory] chatSessionsProvider proposed API unavailable — ' +
        'capture session type not registered. Launch the Extension ' +
        'Development Host with `--enable-proposed-api kubarycz.working-memory`.',
    );
    return;
  }

  // Per-chat-session state: active workstream + the live bottom pill.
  const stateByResource = new Map<string, SessionState>();
  const keyOf = (resource: vscode.Uri | undefined): string =>
    resource?.toString() ?? '__default__';
  const getState = (resource: vscode.Uri | undefined): SessionState => {
    const key = keyOf(resource);
    let s = stateByResource.get(key);
    if (!s) {
      s = { activeSlug: null };
      stateByResource.set(key, s);
    }
    return s;
  };

  // The content provider must be given a default participant; a bare dynamic
  // participant satisfies the API. Its handler routes to the same capture path
  // so behavior is identical if VS Code ever uses it instead of the session's
  // own `requestHandler`.
  const participant = vscode.chat.createChatParticipant(
    `${SESSION_TYPE}.default`,
    async (request, _ctx, stream, token) => {
      await handleCapture(cp, store, getState(undefined), request, stream, token);
      return {};
    },
  );
  context.subscriptions.push(participant);

  const controller = vscode.chat.createChatSessionItemController(
    SESSION_TYPE,
    // Prototype keeps no pre-existing items; new sessions are created on demand.
    async () => {
      /* nothing to refresh yet */
    },
  );
  controller.newChatSessionItemHandler = async (ctx) => {
    const resource = vscode.Uri.from({
      scheme: SCHEME,
      path: `/session/${Date.now()}`,
    });
    return controller.createChatSessionItem(resource, deriveLabel(ctx.request.prompt));
  };
  // Render the active-workstream picker at the bottom of the chat input.
  controller.getChatSessionInputState = async (sessionResource) => {
    const state = getState(sessionResource);
    return controller.createChatSessionInputState([
      await buildWorkstreamGroup(cp, store, state.activeSlug),
    ]);
  };
  context.subscriptions.push(controller);

  const provider: vscode.ChatSessionContentProvider = {
    provideChatSessionContent: (resource, _token, sessionCtx) => {
      const state = getState(resource);
      // Hold the live input state so NL commands can update the bottom pill,
      // and pick up manual dropdown changes the user makes there.
      state.inputState = sessionCtx.inputState;
      const sub = sessionCtx.inputState.onDidChange(() => {
        const picked = sessionCtx.inputState.groups.find(
          (g) => g.id === WORKSTREAM_GROUP_ID,
        )?.selected?.id;
        if (picked && picked !== state.activeSlug) {
          state.activeSlug = picked;
        }
      });
      context.subscriptions.push(sub);
      return {
        history: [],
        requestHandler: async (request, _ctx, stream, token) => {
          await handleCapture(cp, store, state, request, stream, token);
          return {};
        },
      };
    },
  };
  context.subscriptions.push(
    vscode.chat.registerChatSessionContentProvider(SCHEME, provider, participant, {
      supportsInterruptions: true,
    }),
  );

  console.log('[working-memory] capture chat-session type registered.');
}

/** Core request path: NL workstream switch, else respond with workstream context. */
async function handleCapture(
  cp: ControlPlaneClient | null,
  store: JournalStore,
  state: SessionState,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const command = request.prompt?.trim() ?? '';
  if (!command) {
    stream.markdown('Type a note or command, or say **work on <workstream>**.');
    return;
  }

  // Natural-language workstream switch: "work on X", "switch to X", "focus on X".
  const switchMatch = WORK_ON_RE.exec(command);
  if (switchMatch) {
    const requested = switchMatch[1];
    const ws = await resolveWorkstream(cp, store, requested);
    if (!ws) {
      const names = (await listActiveWorkstreams(cp, store)).map(
        (w) => `\`${w.title}\``,
      );
      stream.markdown(
        names.length
          ? `No workstream matches “${requested.trim()}”. Available: ${names.join(', ')}.`
          : 'No workstreams exist yet — create one in the panel first.',
      );
      return;
    }
    state.activeSlug = ws.slug;
    await updatePill(cp, store, state);
    const header = `Now working on **${ws.title}** ([open](${deepLink('workstream', ws.slug)})).`;
    if (!cp) {
      stream.markdown(header);
      return;
    }
    const ctx = await loadWorkstreamContext(cp, ws.slug, ws.title);
    if (!ctx.topics.length) {
      stream.markdown(`${header}\n\nNo associated documents yet.`);
      return;
    }
    const docLines = ctx.topics.map((t) => `- ${topicLink(t)}`).join('\n');
    stream.markdown(
      `${header}\n\nLoaded ${ctx.topics.length} associated ` +
        `document${ctx.topics.length === 1 ? '' : 's'} into context:\n\n${docLines}`,
    );
    return;
  }

  // Processing an item requires an active workstream — "this workstream".
  if (!state.activeSlug) {
    stream.markdown(
      'No workstream selected — say **work on <name>**, or pick one from the ' +
        'Workstream picker below, then send your note.',
    );
    return;
  }
  if (!cp) {
    stream.markdown(
      'Control plane not reachable — cannot load workstream context right now.',
    );
    return;
  }
  const wsSlug = state.activeSlug;

  stream.progress('Loading workstream context…');
  const title =
    (await listActiveWorkstreams(cp, store)).find((w) => w.slug === wsSlug)
      ?.title ?? wsSlug;
  const ctx = await loadWorkstreamContext(cp, wsSlug, title);
  await respondWithContext(cp, ctx, command, stream, token);
}

/** The selected workstream plus its associated (non-closed) topic documents. */
interface WorkstreamContext {
  slug: string;
  title: string;
  topics: CpTopic[];
}

/**
 * Load "this workstream and all its associated documents" — the workstream and
 * the topics whose membership (`spec.workstreams`) includes its slug. This is
 * the context every processed item is grounded in.
 */
async function loadWorkstreamContext(
  cp: ControlPlaneClient,
  wsSlug: string,
  title: string,
): Promise<WorkstreamContext> {
  let topics: CpTopic[] = [];
  try {
    topics = (await cp.topicRead({})).filter(
      (t) => t.status !== 'closed' && !!t.slug && t.workstreams.includes(wsSlug),
    );
  } catch {
    // control-plane hiccup — proceed with an empty document set.
  }
  return { slug: wsSlug, title, topics };
}

/** Safety cap on model turns in the agentic tool loop. */
const MAX_TOOL_ITERATIONS = 8;

/**
 * The workstream-scoped tool surface handed to the model (option B).
 *
 * KEY ENFORCEMENT: `wmc_create_topic` takes NO workstream argument — the handler
 * always stamps the active workstream. So the model cannot create a topic
 * outside "this workstream"; attachment is structural, not a request the model
 * can forget.
 */
const WORKSTREAM_TOOLS: vscode.LanguageModelChatTool[] = [
  {
    name: 'wmc_list_topics',
    description:
      'List the topics already associated with THIS workstream (the active one). Call before creating to avoid duplicates.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wmc_create_topic',
    description:
      'Create a NEW topic. It is ALWAYS associated with the active workstream automatically — do not pass a workstream. Provide a concise title and optional markdown body.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', description: 'Concise topic title.' },
        body: { type: 'string', description: 'Optional markdown body.' },
      },
    },
  },
  {
    name: 'wmc_update_topic',
    description:
      'Update an existing topic by slug (title/body/status). It stays associated with THIS workstream.',
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: {
        slug: { type: 'string', description: 'Slug of the topic to update.' },
        title: { type: 'string' },
        body: { type: 'string' },
        status: { type: 'string', enum: ['open', 'closed'] },
      },
    },
  },
  {
    name: 'wmc_attach_topic',
    description:
      'Associate an EXISTING topic (by slug) with THIS workstream.',
    inputSchema: {
      type: 'object',
      required: ['slug'],
      properties: {
        slug: { type: 'string', description: 'Slug of the topic to attach.' },
      },
    },
  },
];

/**
 * Process the user's item agentically: the model drives, calling the
 * workstream-scoped tools; every topic write is force-stamped with the active
 * workstream in {@link runWorkstreamTool}. "This workstream" is anchored in the
 * preamble.
 */
async function respondWithContext(
  cp: ControlPlaneClient,
  ctx: WorkstreamContext,
  item: string,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const model = await selectBasicModel();
  if (!model) {
    stream.markdown('No language model is available.');
    return;
  }
  const docs = ctx.topics.length
    ? ctx.topics
        .map((t) => {
          const summary = t.body ? ` — ${firstLine(t.body)}` : '';
          return `- ${t.title} (${t.slug})${summary}`;
        })
        .join('\n')
    : '(none yet)';
  const preamble = [
    'You are a Working Memory assistant scoped to exactly ONE workstream.',
    `Active workstream: "${ctx.title}" (slug: ${ctx.slug}).`,
    '"This workstream" always refers to the active workstream above.',
    'Associated documents (topics) currently in this workstream:',
    docs,
    'You have tools to create/update/attach topics. Every topic you create or',
    'update is AUTOMATICALLY associated with this workstream — you never pass a',
    'workstream argument. Prefer wmc_list_topics + updating/attaching an existing',
    'topic over creating a duplicate. Be concise and say what you did.',
  ].join('\n');
  const messages = [
    vscode.LanguageModelChatMessage.User(`${preamble}\n\n---\n\nUser:\n${item}`),
  ];

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      if (token.isCancellationRequested) {
        return;
      }
      const response = await model.sendRequest(
        messages,
        {
          tools: WORKSTREAM_TOOLS,
          toolMode: vscode.LanguageModelChatToolMode.Auto,
          justification: 'Working Memory workstream-scoped assistant.',
        },
        token,
      );

      const assistantParts: Array<
        vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart
      > = [];
      const toolCalls: vscode.LanguageModelToolCallPart[] = [];
      for await (const part of response.stream) {
        if (part instanceof vscode.LanguageModelTextPart) {
          stream.markdown(part.value);
          assistantParts.push(part);
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push(part);
          assistantParts.push(part);
        }
      }
      messages.push(vscode.LanguageModelChatMessage.Assistant(assistantParts));

      if (!toolCalls.length) {
        return; // model is done
      }

      const resultParts: vscode.LanguageModelToolResultPart[] = [];
      for (const call of toolCalls) {
        const out = await runWorkstreamTool(
          cp,
          ctx.slug,
          call.name,
          call.input,
          stream,
        );
        resultParts.push(
          new vscode.LanguageModelToolResultPart(call.callId, [
            new vscode.LanguageModelTextPart(out),
          ]),
        );
      }
      messages.push(vscode.LanguageModelChatMessage.User(resultParts));
    }
    stream.markdown('\n\n_(stopped after reaching the tool-iteration limit.)_');
  } catch (err) {
    stream.markdown(
      `\n\nModel call failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Execute one workstream-scoped tool call against the control-plane. THIS is
 * where workstream attachment is enforced: `create` always passes
 * `workstreams: [wsSlug]`, and `update` re-attaches after patching. The model
 * never gets to choose a different workstream.
 */
async function runWorkstreamTool(
  cp: ControlPlaneClient,
  wsSlug: string,
  name: string,
  input: unknown,
  stream: vscode.ChatResponseStream,
): Promise<string> {
  const args = (input ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case 'wmc_list_topics': {
        const ctx = await loadWorkstreamContext(cp, wsSlug, wsSlug);
        return JSON.stringify({
          ok: true,
          topics: ctx.topics.map((t) => ({
            slug: t.slug,
            title: t.title,
            status: t.status,
            body: firstLine(t.body),
          })),
        });
      }
      case 'wmc_create_topic': {
        const title = String(args.title ?? '').trim();
        if (!title) {
          return JSON.stringify({ ok: false, error: 'title is required' });
        }
        const body = typeof args.body === 'string' ? args.body : '';
        // ENFORCED: always associate with the active workstream.
        const topic = await cp.topicCreate({ title, body, workstreams: [wsSlug] });
        stream.markdown(`\n\n_→ created topic ${topicLink(topic)}_`);
        return JSON.stringify({ ok: true, slug: topic.slug, title: topic.title });
      }
      case 'wmc_update_topic': {
        const slug = String(args.slug ?? '').trim();
        if (!slug) {
          return JSON.stringify({ ok: false, error: 'slug is required' });
        }
        const patch: {
          slug: string;
          title?: string;
          body?: string;
          status?: 'open' | 'closed';
        } = { slug };
        if (typeof args.title === 'string') patch.title = args.title;
        if (typeof args.body === 'string') patch.body = args.body;
        if (args.status === 'open' || args.status === 'closed') {
          patch.status = args.status;
        }
        const topic = await cp.topicUpdate(patch);
        // ENFORCED: keep it attached to the active workstream.
        await cp.topicAttachWorkstream({ slug, workstream: wsSlug });
        stream.markdown(`\n\n_→ updated topic ${topicLink(topic)}_`);
        return JSON.stringify({
          ok: true,
          slug: topic.slug,
          title: topic.title,
          status: topic.status,
        });
      }
      case 'wmc_attach_topic': {
        const slug = String(args.slug ?? '').trim();
        if (!slug) {
          return JSON.stringify({ ok: false, error: 'slug is required' });
        }
        const topic = await cp.topicAttachWorkstream({ slug, workstream: wsSlug });
        stream.markdown(`\n\n_→ attached topic ${topicLink(topic)}_`);
        return JSON.stringify({ ok: true, slug: topic.slug, title: topic.title });
      }
      default:
        return JSON.stringify({ ok: false, error: `unknown tool: ${name}` });
    }
  } catch (err) {
    return JSON.stringify({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Markdown deep link to a topic doc (falls back to bold text if slugless). */
function topicLink(t: CpTopic): string {
  return t.slug ? `[${t.title}](${deepLink('topic', t.slug)})` : `**${t.title}**`;
}

/** First non-empty line of a body, truncated. */
function firstLine(body: string): string {
  const line =
    body.split('\n').map((l) => l.trim()).find((l) => l.length) ?? '';
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

// ---------------------------------------------------------------------------
// Workstream picker (bottom pill) + natural-language resolution
// ---------------------------------------------------------------------------

/**
 * Active (non-closed) workstreams, matching the panel's Active tab.
 *
 * Reads the CONTROL-PLANE (`wsRead`) when a client is present — that is the
 * source of truth the panel renders. Falls back to the journal store only when
 * the control-plane is absent/unreachable. Both filter out closed workstreams.
 */
async function listActiveWorkstreams(
  cp: ControlPlaneClient | null,
  store: JournalStore,
): Promise<Array<{ slug: string; title: string }>> {
  if (cp) {
    try {
      const wss = await cp.wsRead({});
      return wss
        .filter((w) => w.status !== 'closed' && !!w.slug)
        .map((w) => ({ slug: w.slug as string, title: w.title }));
    } catch {
      // control-plane unreachable — fall back to the journal store below.
    }
  }
  try {
    return store
      .listWorkstreams({ status: 'active', orderBy: 'position-asc' })
      .map((w) => ({ slug: w.slug, title: w.title }));
  } catch {
    return [];
  }
}

/** Match a free-text name against an existing workstream (title or slug). */
async function resolveWorkstream(
  cp: ControlPlaneClient | null,
  store: JournalStore,
  rawName: string,
): Promise<{ slug: string; title: string } | undefined> {
  const name = rawName.replace(/\s+workstream\s*$/i, '').trim();
  if (!name) {
    return undefined;
  }
  const lower = name.toLowerCase();
  const kebab = lower.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const wss = await listActiveWorkstreams(cp, store);
  return (
    wss.find((w) => w.title.toLowerCase() === lower) ??
    wss.find((w) => w.slug === kebab || w.slug === lower) ??
    wss.find((w) => w.title.toLowerCase().startsWith(lower)) ??
    wss.find((w) => w.slug.startsWith(kebab))
  );
}

/** Build the "Workstream" option group; `activeSlug` is the selected item. */
async function buildWorkstreamGroup(
  cp: ControlPlaneClient | null,
  store: JournalStore,
  activeSlug: string | null,
): Promise<vscode.ChatSessionProviderOptionGroup> {
  const items: vscode.ChatSessionProviderOptionItem[] = (
    await listActiveWorkstreams(cp, store)
  ).map((w) => ({
    id: w.slug,
    name: w.title,
    description: w.slug,
    icon: workstreamIcon(w.slug),
  }));
  return {
    id: WORKSTREAM_GROUP_ID,
    name: 'Workstream',
    description: 'Active Working Memory workstream',
    items,
    selected: activeSlug ? items.find((i) => i.id === activeSlug) : undefined,
    icon: new vscode.ThemeIcon('git-branch'),
  };
}

/** Push a fresh workstream group into the live input state (re-renders the pill). */
async function updatePill(
  cp: ControlPlaneClient | null,
  store: JournalStore,
  state: SessionState,
): Promise<void> {
  if (state.inputState) {
    state.inputState.groups = [
      await buildWorkstreamGroup(cp, store, state.activeSlug),
    ];
  }
}

/** A filled circle in the workstream's panel color (registered theme colors). */
function workstreamIcon(slug: string): vscode.ThemeIcon {
  return new vscode.ThemeIcon(
    'circle-filled',
    new vscode.ThemeColor(themeColorId(slug)),
  );
}

/** Registered theme-color id for a slug, mirroring the panel's color slots. */
function themeColorId(slug: string): string {
  return `workingMemory.ws.color${colorIndexForId(slug)}`;
}

/** Deterministic color slot for an id — mirrors media/panel/panel.js. */
function colorIndexForId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h) % WS_COLOR_SLOTS;
}

async function selectBasicModel(): Promise<vscode.LanguageModelChat | undefined> {
  for (const family of MODEL_FAMILIES) {
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot', family });
    if (models[0]) {
      return models[0];
    }
  }
  const any = await vscode.lm.selectChatModels({ vendor: 'copilot' });
  return any[0];
}

/**
 * Canonical Working Memory deep link. Opens the given object in the extension's
 * virtual-doc UI via the registered URI handler. Format mirrors
 * `deepLink()` in `src/virtualFileRenderer/shared.ts` and the rule documented
 * in the workspace `AGENTS.md`: `vscode://kubarycz.working-memory/open/<kind>/<id>`.
 */
function deepLink(kind: 'workstream' | 'topic', id: string): string {
  return `vscode://kubarycz.working-memory/open/${kind}/${encodeURIComponent(id)}`;
}

function deriveLabel(prompt: string): string {
  const clean = prompt.trim().replace(/\s+/g, ' ');
  if (clean.length <= 40) {
    return clean || 'Capture';
  }
  return `${clean.slice(0, 39)}…`;
}
