/**
 * Prototype "Capture" chat-session provider.
 *
 * Registers a Working Memory session TYPE (via the proposed `chatSessionsProvider`
 * API) whose sole job is: take whatever command/note the user types and convert
 * it into Working Memory journal entries using a basic Copilot model. Every
 * prompt becomes one or more `prefix: text` entries appended to a dedicated
 * capture session in the journal DB.
 *
 * Self-contained: the only outside touch points are `activate()` calling
 * {@link registerCaptureChatSession} and the `chatSessions` /
 * `enabledApiProposals` manifest additions. Everything degrades to a no-op when
 * the proposed API is unavailable (i.e. not launched with
 * `--enable-proposed-api`).
 */

import * as vscode from 'vscode';
import type { JournalStore } from '../db';

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
const WORKSTREAM_SLUG = 'capture-inbox';
const WORKSTREAM_TITLE = 'Capture Inbox';
/** `created_by` stamp for every entry this provider writes. */
const CREATED_BY = 'chat-capture';
/** Preferred lightweight model families, tried in order. */
const MODEL_FAMILIES = ['gpt-4o-mini', 'gpt-4o'];

const ENTRY_PREFIXES = [
  'chat',
  'command',
  'file',
  'system',
  'decision',
  'fact',
  'idea',
  'question',
] as const;

interface CaptureEntry {
  prefix: string;
  text: string;
}

/**
 * Wire up the capture session type. No-op (with a console note) when the
 * proposed API isn't present, so it never breaks activation.
 */
export function registerCaptureChatSession(
  context: vscode.ExtensionContext,
  store: JournalStore,
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

  // Maps a chat-session resource URI → the Working Memory session_id it writes
  // to, so repeated prompts in the same chat land in one journal session.
  const sessionIdByResource = new Map<string, string>();

  // The content provider must be given a default participant; a bare dynamic
  // participant satisfies the API. Its handler is never the primary path — the
  // per-session `requestHandler` below does the work — but we make it capture
  // too, so it behaves identically if VS Code routes through it.
  const participant = vscode.chat.createChatParticipant(
    `${SESSION_TYPE}.default`,
    async (request, _ctx, stream, token) => {
      await handleCapture(store, sessionIdByResource, undefined, request, stream, token);
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
  context.subscriptions.push(controller);

  const provider: vscode.ChatSessionContentProvider = {
    provideChatSessionContent: (resource) => ({
      history: [],
      requestHandler: async (request, _ctx, stream, token) => {
        await handleCapture(
          store,
          sessionIdByResource,
          resource,
          request,
          stream,
          token,
        );
        return {};
      },
    }),
  };
  context.subscriptions.push(
    vscode.chat.registerChatSessionContentProvider(SCHEME, provider, participant, {
      supportsInterruptions: true,
    }),
  );

  console.log('[working-memory] capture chat-session type registered.');
}

/** Core request path: prompt → journal entries → receipt. */
async function handleCapture(
  store: JournalStore,
  sessionIdByResource: Map<string, string>,
  resource: vscode.Uri | undefined,
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<void> {
  const command = request.prompt?.trim() ?? '';
  if (!command) {
    stream.markdown('Nothing to capture — type a command or note.');
    return;
  }

  let sessionId: string;
  try {
    sessionId = ensureSession(store, sessionIdByResource, resource);
  } catch (err) {
    stream.markdown(
      `Could not open a capture session: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  stream.progress('Converting to Working Memory…');
  const entries = await convertToEntries(command, token);

  let written = 0;
  for (const entry of entries) {
    try {
      store.appendEntry({
        session_id: sessionId,
        body: `${entry.prefix}: ${entry.text}`,
        created_by: CREATED_BY,
      });
      written++;
    } catch (err) {
      console.error('[working-memory] capture appendEntry failed:', err);
    }
  }

  stream.markdown(renderReceipt(entries.slice(0, written)));
}

/**
 * Resolve (and lazily create) the Working Memory session backing a chat
 * session. Keyed by the chat resource; the default-participant path (no
 * resource) shares a single fallback session.
 */
function ensureSession(
  store: JournalStore,
  sessionIdByResource: Map<string, string>,
  resource: vscode.Uri | undefined,
): string {
  const key = resource?.toString() ?? '__default__';
  const existing = sessionIdByResource.get(key);
  if (existing) {
    return existing;
  }
  ensureWorkstream(store);
  const session = store.startSession({
    workstream_slug: WORKSTREAM_SLUG,
    summary: 'Chat capture session',
  });
  sessionIdByResource.set(key, session.session_id);
  return session.session_id;
}

/** Ensure the capture workstream exists; tolerate a pre-existing/soft-deleted slug. */
function ensureWorkstream(store: JournalStore): void {
  if (store.getWorkstreamBySlug(WORKSTREAM_SLUG)) {
    return;
  }
  try {
    store.createWorkstream({ slug: WORKSTREAM_SLUG, title: WORKSTREAM_TITLE });
  } catch {
    // Another path may have created it, or the slug is soft-deleted — either
    // way, if it's now resolvable we're fine; otherwise re-throw on use.
    if (!store.getWorkstreamBySlug(WORKSTREAM_SLUG)) {
      throw new Error(`capture workstream '${WORKSTREAM_SLUG}' is unavailable`);
    }
  }
}

/**
 * Ask a basic Copilot model to split the command into typed entries. Falls back
 * to a single `command:` entry if no model is available or the reply can't be
 * parsed — so capture always succeeds.
 */
async function convertToEntries(
  command: string,
  token: vscode.CancellationToken,
): Promise<CaptureEntry[]> {
  try {
    const model = await selectBasicModel();
    if (!model) {
      return [fallbackEntry(command)];
    }
    const messages = [
      vscode.LanguageModelChatMessage.User(`${CONVERT_INSTRUCTIONS}\n\nCOMMAND:\n${command}`),
    ];
    const response = await model.sendRequest(
      messages,
      {
        justification:
          'Working Memory capture: convert a command into journal entries.',
      },
      token,
    );
    let reply = '';
    for await (const chunk of response.text) {
      reply += chunk;
    }
    return parseEntries(reply, command);
  } catch (err) {
    console.error('[working-memory] capture model call failed:', err);
    return [fallbackEntry(command)];
  }
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

const CONVERT_INSTRUCTIONS = [
  "You convert a user's raw command or note into Working Memory journal entries.",
  'Reply with STRICT JSON only — no prose, no code fences — in exactly this shape:',
  '{"entries":[{"prefix":"<type>","text":"<concise one-line entry>"}]}',
  'Where <type> is one of: chat | command | file | system | decision | fact | idea | question.',
  'Rules:',
  '- Prefer 1-3 entries. Split only when the command clearly contains distinct facts/actions.',
  '- Each text is one short line. Do not restate the JSON keys or the prefix inside text.',
  '- Use "command" for an explicit instruction/request, "decision" for a choice (note why),',
  '  "fact" for a durable fact, "idea"/"question" for things to revisit, "file"/"system"',
  '  for concrete changes.',
].join('\n');

function parseEntries(reply: string, command: string): CaptureEntry[] {
  const match = reply.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { entries?: unknown };
      if (Array.isArray(parsed.entries)) {
        const out: CaptureEntry[] = [];
        for (const raw of parsed.entries) {
          if (raw && typeof raw === 'object') {
            const rec = raw as Record<string, unknown>;
            const prefix = String(rec.prefix ?? '').toLowerCase();
            const text = String(rec.text ?? '').trim();
            if (text) {
              out.push({
                prefix: (ENTRY_PREFIXES as readonly string[]).includes(prefix)
                  ? prefix
                  : 'command',
                text,
              });
            }
          }
        }
        if (out.length) {
          return out;
        }
      }
    } catch {
      // fall through to the single-entry fallback
    }
  }
  return [fallbackEntry(command)];
}

function fallbackEntry(command: string): CaptureEntry {
  return { prefix: 'command', text: command };
}

function renderReceipt(entries: CaptureEntry[]): string {
  if (!entries.length) {
    return 'No entries were captured.';
  }
  const lines = entries.map((e) => `- \`${e.prefix}:\` ${e.text}`);
  const noun = entries.length === 1 ? 'entry' : 'entries';
  return `Captured ${entries.length} ${noun} to Working Memory:\n\n${lines.join('\n')}`;
}

function deriveLabel(prompt: string): string {
  const clean = prompt.trim().replace(/\s+/g, ' ');
  if (clean.length <= 40) {
    return clean || 'Capture';
  }
  return `${clean.slice(0, 39)}…`;
}
