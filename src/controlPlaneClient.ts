/**
 * Extension-host MCP client for the Working Memory control-plane (WM 13.0
 * "blackboard-tab").
 *
 * The Blackboard tab is the agentic-first test harness for the document store:
 * it reads documents through the SAME MCP surface an agent uses — the
 * control-plane's Streamable-HTTP `/mcp` endpoint — rather than the journal DB,
 * a REST side-channel, or VS Code's `lm.invokeTool` plumbing. Reading through
 * the real `wm-document-read` tool means a bug in the
 * tool handler, its Zod schema, or the transport shows up HERE instead of being
 * masked. Using our own SDK `Client` (not VS Code's MCP client) isolates our
 * server so a broken Blackboard points at our code, not the editor's.
 *
 * Everything here is best-effort: when the daemon isn't running (no port file)
 * or a call fails, we return a typed "unavailable" result so the UI can render
 * an empty state. A dropped connection resets the lazy-singleton client so the
 * next call reconnects. The module is VS Code-free so it can be unit-tested
 * against an ephemeral in-process server.
 *
 * The SDK ships dual CJS/ESM behind an `exports` map. The extension is built
 * with `module: commonjs` / classic node resolution, which ignores `exports`,
 * so `tsconfig.json` maps `@modelcontextprotocol/sdk/*` to the physical
 * `dist/cjs/*` types; the runtime `require` still resolves the public subpath
 * via the package's catch-all export.
 */

import * as os from 'node:os';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  controlPlanePortFilePath,
  parsePortInfo,
  resolveControlPlaneHome,
} from './controlPlaneShared';
import {
  COMMAND_JOURNAL_KIND,
  filterAndSortJournals,
  type CommandJournalDoc,
  type CommandJournalSpec,
} from './commandJournal';

/** Client identity advertised to the control-plane during the MCP handshake. */
const CLIENT_NAME = 'working-memory-extension';
const CLIENT_VERSION = '0.1.0';

/**
 * The document envelope as returned by the control-plane store — mirrored here
 * (the extension build and the control-plane build are separate TS programs).
 * Kept structurally identical to `control-plane/src/store.ts::DocumentEnvelope`.
 */
export interface DocumentEnvelope {
  kind: string;
  metadata: {
    id: string;
    slug: string | null;
    labels: Record<string, string>;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
    resourceVersion: number;
  };
  spec: Record<string, unknown>;
  status: Record<string, unknown>;
}

/** Result of `listDocuments` — `available:false` means the daemon is down / a call failed. */
export interface ListDocumentsResult {
  available: boolean;
  documents: DocumentEnvelope[];
  /** Present when `available` is false. */
  error?: string;
}

/** Result of `getDocument` — `document:null` means "not found" when available. */
export interface GetDocumentResult {
  available: boolean;
  document: DocumentEnvelope | null;
  error?: string;
}

export interface GetDocumentInput {
  id?: string;
  slug?: string;
  kind?: string;
  /**
   * When true, a by-id/slug read also returns a soft-deleted document. Used to
   * locate a workstream document by slug in order to undelete it (restore is by
   * id, but callers only know the slug). Defaults to false (live rows only).
   */
  includeDeleted?: boolean;
}

/**
 * Result of a write (`createDocument`/`updateDocument`/`deleteDocument`).
 *
 * Mirrors the read-result pattern's `available` flag but adds a third state so
 * callers can tell a dead daemon apart from a tool-level rejection:
 *   - `available:false`               → daemon unreachable / transport failed
 *     (same meaning as the read results). `error` carries the transport error.
 *   - `available:true`, `document:null`, `error` set → the tool ran but
 *     REJECTED the write (unknown id, version conflict, spec validation, …).
 *     The control-plane's `asError` returns a plain-text message, surfaced here.
 *   - `available:true`, `document` set → success; `document` is the envelope.
 */
export interface WriteDocumentResult {
  available: boolean;
  document: DocumentEnvelope | null;
  error?: string;
}

export interface CreateDocumentInput {
  kind: string;
  slug?: string;
  labels?: Record<string, string>;
  spec?: Record<string, unknown>;
}

export interface UpdateDocumentInput {
  id: string;
  expectedResourceVersion: number;
  spec?: Record<string, unknown>;
  slug?: string;
  labels?: Record<string, string>;
}

export interface DeleteDocumentInput {
  id: string;
  restore?: boolean;
  expectedResourceVersion?: number;
}

/**
 * The authored workstream lifecycle status (a `spec` field), mirroring migration
 * 014 and the control-plane Workstream kind enum. Legacy 'open' is NOT part of
 * this enum — it only ever existed as a pre-migration DB value.
 */
export type WorkstreamLifecycleStatus = 'queue' | 'progress' | 'backlog' | 'closed';

/**
 * The legacy workstream shape returned by the control-plane `ws-*` domain API
 * (mapped from a Workstream document by the kind's `Workstream` POCO). This
 * client OWNS the type: the extension-host consumers (LM tools, panel, commands)
 * speak this shape and no longer reach through the retired
 * `src/domain/workstreams.ts` mapping. Kept structurally identical to
 * `control-plane/src/kinds/workstream/workstream.ts::IWorkstream`.
 */
export interface Workstream {
  /** Document id (uuid). Distinct from the legacy integer rowid. */
  id: string;
  slug: string | null;
  title: string;
  status: WorkstreamLifecycleStatus;
  closure: string | null;
  opened_at: number;
  updated_at: number;
  closed_at: number | null;
  /** CAS counter from the envelope, for a subsequent update. */
  resourceVersion: number;
}

/**
 * Thrown by the typed `ws-*` domain methods (`wsRead`/`wsCreate`/`wsUpdate`/
 * `wsDelete`) when the daemon is unreachable or a tool result is flagged
 * `isError` (unknown slug, version conflict, spec validation, …). Unlike the
 * generic `wm-document-*` helpers — which return an `{ available }` result
 * wrapper so the Blackboard can render an empty state — the domain methods
 * return the mapped value directly, so failures MUST throw. The control-plane's
 * plain-text `asError` message is preserved so conflicts / not-found surface
 * clearly to the caller (the LM-tool `safe()` wrapper, panel refresh, commands).
 */
export class ControlPlaneClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlPlaneClientError';
  }
}

export interface WsReadInput {
  slug?: string;
  id?: string;
  query?: string;
  limit?: number;
}

export interface WsCreateInput {
  slug?: string;
  title: string;
  status?: string;
  closure?: string;
}

export interface WsUpdateInput {
  slug: string;
  title?: string;
  status?: string;
  closure?: string;
}

export interface WsDeleteInput {
  slug: string;
  restore?: boolean;
}

/**
 * The topic shape returned by the control-plane `ws-topic-*` domain API (mapped
 * from a Topic document by the kind's `Topic` POCO). This client OWNS the type,
 * exactly as it owns {@link Workstream}: the extension-host topic consumers (LM
 * tools, panel, commands, the topic virtual doc) speak this shape and no longer
 * reach through the journal `topics` table (WM 13.0 "topic-consumer-repoint").
 * Kept structurally identical to
 * `control-plane/src/kinds/topic/topic.ts::ITopic`.
 *
 * Two relational fields are flat slug arrays (spec refs), NOT the journal's rich
 * join rows:
 *   - `workstreams` — the member workstream slugs. Per-workstream focus is a
 *     separate `focusedWorkstreams` subset (there is no per-link `focused` flag
 *     the way the journal join row carried one).
 *   - `focusedWorkstreams` — the subset of `workstreams` for which this topic is
 *     focused/pinned. A workstream's focused topics = topics whose
 *     `focusedWorkstreams` includes that workstream's slug.
 *   - `parents` — the parent topic slugs (the topic DAG).
 */
export interface Topic {
  /** Document id (uuid). */
  id: string;
  slug: string | null;
  title: string;
  body: string;
  status: 'open' | 'closed';
  topicType: string;
  /** Parent topic slugs (the topic DAG). */
  parents: string[];
  /** Member workstream slugs (topic↔workstream membership). */
  workstreams: string[];
  /** Subset of `workstreams` this topic is focused/pinned in (per-workstream focus). */
  focusedWorkstreams: string[];
  created_at: number;
  updated_at: number;
  /** CAS counter from the envelope, for a subsequent update. */
  resourceVersion: number;
}

export interface TopicReadInput {
  slug?: string;
  id?: string;
  query?: string;
  /** Filter to topics whose `workstreams` membership includes this slug. */
  workstream?: string;
  limit?: number;
}

export interface TopicCreateInput {
  slug?: string;
  title: string;
  body?: string;
  status?: string;
  topicType?: string;
  parents?: string[];
  workstreams?: string[];
  focusedWorkstreams?: string[];
}

export interface TopicUpdateInput {
  slug: string;
  title?: string;
  body?: string;
  status?: string;
  topicType?: string;
  parents?: string[];
  workstreams?: string[];
  focusedWorkstreams?: string[];
}

export interface TopicType {
  id: string;
  slug: string | null;
  label: string;
  icon: string;
  description: string;
  body_template: string;
  created_at: number;
  updated_at: number;
  /** CAS counter from the envelope, for a subsequent update. */
  resourceVersion: number;
}

export interface TopicTypeReadInput {
  slug?: string;
  id?: string;
  query?: string;
  limit?: number;
}

export interface TopicTypeUpdateInput {
  slug: string;
  label?: string;
  icon?: string;
  description?: string;
  body_template?: string;
}

export interface TopicTypeCreateInput {
  slug?: string;
  label: string;
  icon: string;
  description: string;
  body_template?: string;
}

/**
 * A "configmap": a named bag of string key-value pairs (`data`), identified by
 * a registry-key `slug`. A nanite references configmaps by slug/id and, on run,
 * their merged `data` is injected into its dev container as environment
 * variables. `data` values are always strings.
 */
export interface Config {
  id: string;
  slug: string | null;
  name: string;
  /** The key-value pairs. Values are always strings. */
  data: Record<string, string>;
  status: string;
  created_at: number;
  updated_at: number;
  /** CAS counter from the envelope, for a subsequent update. */
  resourceVersion: number;
}

export interface ConfigReadInput {
  slug?: string;
  id?: string;
  query?: string;
  limit?: number;
}

export interface ConfigCreateInput {
  slug?: string;
  name?: string;
  data: Record<string, string>;
  status?: string;
}

export interface ConfigUpdateInput {
  slug: string;
  name?: string;
  /** Key-value pairs to MERGE onto the existing map. */
  data?: Record<string, string>;
  status?: string;
}

export interface ConfigDeleteInput {
  slug: string;
  restore?: boolean;
}

export interface TopicDeleteInput {
  slug: string;
  restore?: boolean;
}

export interface TopicAttachWorkstreamInput {
  slug: string;
  workstream: string;
}

export interface TopicDetachWorkstreamInput {
  slug: string;
  workstream: string;
}

export interface TopicSetFocusInput {
  slug: string;
  workstream: string;
}

export interface TopicClearFocusInput {
  slug: string;
  workstream: string;
}

/**
 * The alert shape returned by the control-plane `ws-alert-read` domain API
 * (mapped from an Alert document by the kind's `Alert` POCO). This client OWNS
 * the type, exactly as it owns {@link Workstream} and {@link Topic}: the
 * extension-host consumers (panel bubble aggregation) speak this shape and no
 * longer reach through the journal `alerts` table for the control-plane cards.
 * Kept structurally identical to
 * `control-plane/src/kinds/alert/alert.ts::IAlert`.
 *
 * `topics` is a flat topic-slug reference array (`spec.topics`) — the same slug
 * space the Topic membership uses — so a card's bubble can be computed by
 * matching an alert's `topics` against a topic (or workstream member) slug.
 */
export interface Alert {
  /** Document id (uuid). Alerts have no slug (always null). */
  id: string;
  slug: string | null;
  title: string;
  description: string;
  recommended_action: string;
  /** Authored lifecycle status; `closed` alerts are excluded from bubbles. */
  status: 'alert' | 'informational' | 'closed';
  dedupe_key: string | null;
  created_by: string;
  /** Referenced topic slugs (the same slug space as Topic membership). */
  topics: string[];
  created_at: number;
  updated_at: number;
  /** CAS counter from the envelope, for a subsequent update. */
  resourceVersion: number;
}

export interface AlertReadInput {
  id?: string;
  query?: string;
  limit?: number;
}

/**
 * Fields for `ws-alert-update` (identified by `id`; only the provided fields are
 * sent). Mirrors {@link TopicUpdateInput}: a partial patch the control-plane
 * merges + re-validates before a compare-and-swap write.
 */
export interface AlertUpdateInput {
  id: string;
  status?: 'alert' | 'informational' | 'closed';
  title?: string;
  description?: string;
  recommended_action?: string;
  dedupe_key?: string | null;
  created_by?: string;
  topics?: string[];
}

/**
 * Fields for `ws-alert-create`. Alerts have NO slug — the control-plane returns
 * the created alert (whose `id` is the handle for later update/delete). Only
 * `description` is required by the kind; the rest default server-side.
 */
export interface AlertCreateInput {
  description: string;
  title?: string;
  recommended_action?: string;
  status?: 'alert' | 'informational' | 'closed';
  dedupe_key?: string | null;
  created_by?: string;
  topics?: string[];
}

/** Fields for `ws-alert-delete` (identified by `id`; `restore` undeletes). */
export interface AlertDeleteInput {
  id: string;
  restore?: boolean;
}

/**
 * The Nanite Template shape returned by the control-plane `ws-nanitetemplate-*`
 * domain API. Kept structurally identical to
 * `control-plane/src/kinds/naniteTemplate/naniteTemplate.ts::INaniteTemplate`.
 * A Nanite Template is the reusable DEFINITION; a {@link Nanite} is one
 * execution instance of it.
 */
export interface NaniteTemplate {
  id: string;
  slug: string | null;
  title: string;
  triggerPhrase: string;
  instructions: string;
  executionSettings: Record<string, unknown>;
  toolAllowlist: string[];
  toolDenylist: string[];
  allowRunWithoutHuman: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  acceptanceCriteria: string;
  acceptanceThreshold: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

export interface NaniteTemplateReadInput {
  slug?: string;
  id?: string;
  query?: string;
  limit?: number;
}

export interface NaniteTemplateCreateInput {
  slug?: string;
  title: string;
  triggerPhrase?: string;
  instructions?: string;
  executionSettings?: Record<string, unknown>;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  allowRunWithoutHuman?: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  acceptanceCriteria?: string;
  acceptanceThreshold?: number;
  enabled?: boolean;
}

export interface NaniteTemplateUpdateInput {
  slug: string;
  title?: string;
  triggerPhrase?: string;
  instructions?: string;
  executionSettings?: Record<string, unknown>;
  toolAllowlist?: string[];
  toolDenylist?: string[];
  allowRunWithoutHuman?: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  acceptanceCriteria?: string;
  acceptanceThreshold?: number;
  enabled?: boolean;
}

export interface NaniteTemplateDeleteInput {
  slug: string;
  restore?: boolean;
}

/** The Nanite lifecycle phase, mirroring the control-plane Nanite kind enum. */
export type NanitePhase = 'Pending' | 'Queued' | 'Running' | 'Succeeded' | 'Failed';

/** The acceptance-judge verdict persisted on a finished Nanite. */
export interface NaniteAcceptance {
  summary: string;
  confidence: number;
  threshold: number;
  passed: boolean;
}

/** One entry in a Nanite run's tool-call trail. */
export interface NaniteToolCallOutcome {
  name: string;
  ok: boolean;
  error?: string;
}

/**
 * One ordered step in a Nanite run's execution trace — the model's narration
 * (`kind: 'assistant'`) interleaved with each tool call (`kind: 'tool'`), in
 * execution order. Structurally identical to the control-plane
 * `kinds/nanite/nanite.ts::NaniteRunStep`.
 */
export interface NaniteRunStep {
  kind: 'assistant' | 'tool';
  /** Model-turn index this step occurred in (the run's round / round-trip). */
  round?: number;
  text?: string;
  name?: string;
  ok?: boolean;
  input?: string;
  result?: string;
  error?: string;
  /**
   * Compact, body-free digest of a WM READ tool result (`kind: 'tool'`, success
   * only), captured from the FULL result before `result` was truncated. Mirror
   * of the control-plane `NaniteReadResultDigest`.
   */
  resultDigest?: {
    count: number;
    items: Array<{
      id?: string;
      slug?: string;
      title?: string;
      name?: string;
      resourceVersion?: number;
    }>;
  };
}

/** Approximate token usage (loop + judge) recorded on a finished Nanite. */
export interface NaniteTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/**
 * The Nanite shape returned by the control-plane `ws-nanite-*` domain API — ONE
 * execution instance of a {@link NaniteTemplate}. Kept structurally identical to
 * `control-plane/src/kinds/nanite/nanite.ts::INanite`. `workstream` + `inputTopic`
 * are immutable at creation.
 */
export interface Nanite {
  id: string;
  slug: string | null;
  templateId: string | null;
  workstream: string;
  inputTopic: string;
  /** Configmap slugs/ids whose merged `data` is injected into the run's container as env. */
  configs: string[];
  request: string;
  phase: NanitePhase;
  /** Unix seconds the nanite was enqueued for dispatch (null until Queued). */
  queuedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  error: string;
  /**
   * Light pointer to the newest {@link NaniteJournal} record for this nanite
   * (null until the first run). The run RESULT — prompt/output/steps/acceptance/
   * tokens/missingTools — lives in that journal document, NEVER on the
   * nanite spec.
   */
  latestJournalId: string | null;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

export interface NaniteReadInput {
  id?: string;
  inputTopic?: string;
  workstream?: string;
  phase?: NanitePhase;
  limit?: number;
}

export interface NaniteCreateInput {
  workstream: string;
  inputTopic?: string;
  templateId?: string;
  /** Configmap slugs/ids injected as dev-container env (immutable at creation). */
  configs?: string[];
  request?: string;
}

export interface NaniteUpdateInput {
  id: string;
  /** Optional CAS guard — the resourceVersion the caller last read. */
  expectedResourceVersion?: number;
  /** Replacement configmap slugs/ids injected as dev-container env. */
  configs?: string[];
  /** New free-text request/prompt for this execution. */
  request?: string;
}

export interface NaniteRunInput {
  id: string;
  /** Human approval to enqueue a Pending nanite (set by the Run action). */
  approved?: boolean;
  /** Set by the extension-host runner to START execution (Queued|Pending → Running). */
  begin?: boolean;
  outcome?: 'succeeded' | 'failed';
  error?: string;
  /**
   * Document id of the run's {@link NaniteJournal} record (finishing call).
   * Stored as a light pointer to the newest run; the run RESULT itself lives in
   * that journal document, never on the nanite spec.
   */
  latestJournalId?: string;
  /** Reset the nanite back to Pending from any phase (clears a stuck run). */
  reset?: boolean;
}

export interface NaniteDeleteInput {
  id: string;
  restore?: boolean;
}

/** A run's terminal outcome (null until it finishes). */
export type NaniteRunOutcome = 'succeeded' | 'failed' | null;

/** Section 1 of a {@link NaniteJournal} — lifecycle phase/outcome + timing. */
export interface NaniteJournalStatus {
  phase: NanitePhase;
  outcome: NaniteRunOutcome;
  queuedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

/** Section 2 of a {@link NaniteJournal} — the full run input handed to the model. */
export interface NaniteJournalPrompt {
  request: string;
}

/** Section 3 of a {@link NaniteJournal} — the turn trace + any error. */
export interface NaniteJournalExecution {
  steps: NaniteRunStep[];
  error: string;
}

/** Section 4 of a {@link NaniteJournal} — summary, verdict, and stats. */
export interface NaniteJournalResults {
  summary: string;
  acceptance: NaniteAcceptance | null;
  tokens: NaniteTokenUsage | null;
  missingTools: string[];
}

/**
 * The NaniteJournal shape returned by the control-plane `ws-nanitejournal-*`
 * domain API — ONE immutable record of a single {@link Nanite} run. Kept
 * structurally identical to
 * `control-plane/src/kinds/nanitejournal/naniteJournal.ts::INaniteJournal`.
 */
export interface NaniteJournal {
  id: string;
  slug: string | null;
  /** The owning nanite's document id (REQUIRED). */
  naniteId: string;
  /** The owning workstream slug (scope). */
  workstream: string;
  /** The input topic slug (scope; empty for a workstream-wide run). */
  inputTopic: string;
  status: NaniteJournalStatus;
  prompt: NaniteJournalPrompt;
  execution: NaniteJournalExecution;
  results: NaniteJournalResults;
  created_at: number;
  updated_at: number;
  resourceVersion: number;
}

export interface NaniteJournalCreateInput {
  /** The owning nanite's document id (required). */
  naniteId: string;
  workstream?: string;
  inputTopic?: string;
  status?: Partial<NaniteJournalStatus>;
  prompt?: Partial<NaniteJournalPrompt>;
  execution?: Partial<NaniteJournalExecution>;
  results?: Partial<NaniteJournalResults>;
}

export interface NaniteJournalReadInput {
  /** Read ONE journal by document id. */
  id?: string;
  /** List a single nanite's run history (its document id), newest-first. */
  naniteId?: string;
  /** Max journals to return (list mode). */
  limit?: number;
}


export interface ControlPlaneClientOptions {
  /**
   * Resolve the `/mcp` URL to connect to, or `null` when the daemon is
   * unavailable. Defaults to reading the discovery port file. Tests inject a
   * fixed URL pointing at an ephemeral in-process server.
   */
  resolveUrl?: () => string | null;
  /**
   * Whether the `WM_CONTROL_PLANE_HOME` env override may steer the default URL
   * resolver. Only true in Development (the F5 sandbox); in Production the env
   * is ignored so a leaked sandbox var can't repoint chat's tools at the
   * sandbox daemon. Ignored when `resolveUrl` is supplied.
   */
  allowEnvOverride?: boolean;
  /**
   * Sink for transport-level errors surfaced by the MCP SDK (SSE stream
   * disconnects, failed reconnection attempts). Best-effort observability only:
   * these fire when the daemon dies while a stream is open and are expected
   * during a control-plane restart/shutdown. Defaults to a no-op (keeps this
   * module VS Code-free / unit-testable).
   */
  onError?: (err: unknown) => void;
}

/**
 * One canonical tool as advertised by the control-plane's MCP `tools/list`. The
 * command widget derives its LOCAL tool catalog from these so the control-plane
 * kind files are the single source of truth (WM 14.2.1
 * "derive-local-tools-from-canonical-registry"). `inputSchema` is already JSON
 * Schema (the SDK converts the kind's zod shape), so it maps almost directly
 * into a local `LlamaToolDef.function.parameters`.
 */
export interface CanonicalToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/**
 * Structured outcome of the generic {@link ControlPlaneClient.callTool} used by
 * the command widget's generic dispatch. Unlike the typed `ws-*` domain methods
 * (which throw), this mirrors the read-result pattern: `ok:false` for a dead
 * daemon OR a tool-level rejection (`isError`), `ok:true` with the parsed JSON
 * payload otherwise.
 */
export interface ToolCallOutcome {
  ok: boolean;
  /** Parsed JSON payload from the tool's text content on success. */
  result?: unknown;
  /** Error message when the daemon is unreachable or the tool rejected the call. */
  error?: string;
}

/** MCP text content shape (a subset of the SDK's `CallToolResult.content`). */
interface TextContentLike {
  type: string;
  text?: string;
}

/**
 * Parse the single text content block of an MCP tool result as JSON. Tool
 * results come back as `{ content: [{ type:'text', text: JSON.stringify(...) }]}`.
 * Returns `null` when there is no parseable text block.
 */
function parseToolText(result: unknown): unknown {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return null;
  }
  const block = (content as TextContentLike[]).find(
    (c) => c && c.type === 'text' && typeof c.text === 'string',
  );
  if (!block || typeof block.text !== 'string') {
    return null;
  }
  try {
    return JSON.parse(block.text);
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Extract the plain-text message from a tool result flagged `isError`. The
 * control-plane's `asError` returns `{ isError:true, content:[{type:'text',
 * text:<message>}] }` where `text` is a RAW message string (not JSON), unlike
 * the success path which JSON-encodes the envelope.
 */
function errorTextOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const block = (content as TextContentLike[]).find(
      (c) => c && c.type === 'text' && typeof c.text === 'string',
    );
    if (block && typeof block.text === 'string' && block.text.length > 0) {
      return block.text;
    }
  }
  return 'Control plane returned an error';
}

/**
 * Interpret a document write tool result into a {@link WriteDocumentResult}.
 * `isError` results become an available-but-rejected result carrying the
 * message; a success result is parsed as the envelope JSON.
 */
function interpretWriteResult(result: unknown): WriteDocumentResult {
  if ((result as { isError?: unknown }).isError === true) {
    return { available: true, document: null, error: errorTextOf(result) };
  }
  const parsed = parseToolText(result) as DocumentEnvelope | null;
  if (!parsed || !parsed.metadata || !parsed.kind) {
    return { available: true, document: null, error: 'Malformed control-plane response' };
  }
  return { available: true, document: parsed };
}


/**
 * Default URL resolver: read the discovery port file (`{ port, pid }`) under
 * the control-plane home and return its `/mcp` URL. `null` when the file is
 * missing or malformed (daemon not running yet).
 */
function defaultResolveUrl(allowEnvOverride: boolean): string | null {
  const home = resolveControlPlaneHome({
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    allowEnvOverride,
  });
  const portFile = controlPlanePortFilePath(home);
  let raw: string;
  try {
    raw = readFileSync(portFile, 'utf8');
  } catch {
    return null;
  }
  const info = parsePortInfo(raw);
  if (!info) {
    return null;
  }
  return `http://127.0.0.1:${info.port}/mcp`;
}

/**
 * Declines the SDK's standalone GET SSE notification stream (405) so it never
 * opens — we don't use notifications, and its socket is what rejected undici's
 * uncatchable `TypeError: terminated`. POST/DELETE fall through to real `fetch`.
 */
const sseDecliningFetch = (url: string | URL, init?: RequestInit): Promise<Response> => {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method === 'GET') {
    return Promise.resolve(
      new Response(null, { status: 405, statusText: 'SSE notification stream disabled by client' }),
    );
  }
  return fetch(url, init);
};

/**
 * Lazy-singleton MCP client for the control-plane. Connects on first use and
 * reuses the session across calls; a failed call drops the client so the next
 * one reconnects (handling daemon restarts / dropped connections).
 */
export class ControlPlaneClient {
  private readonly resolveUrl: () => string | null;
  private readonly onError: (err: unknown) => void;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  /** In-flight connect, so concurrent calls share one handshake. */
  private connecting: Promise<Client | null> | null = null;
  private disposed = false;

  constructor(options: ControlPlaneClientOptions = {}) {
    this.resolveUrl =
      options.resolveUrl ?? (() => defaultResolveUrl(options.allowEnvOverride ?? false));
    this.onError = options.onError ?? (() => {});
  }

  /** List documents via `wm-document-read` (list mode), optionally filtered by `kind`. */
  async listDocuments(kind?: string): Promise<ListDocumentsResult> {
    const client = await this.ensureConnected();
    if (!client) {
      return { available: false, documents: [], error: 'Control plane not running' };
    }
    try {
      const result = await client.callTool({
        name: 'wm-document-read',
        arguments: kind ? { kind } : {},
      });
      const parsed = parseToolText(result) as { documents?: unknown } | null;
      const documents = Array.isArray(parsed?.documents)
        ? (parsed!.documents as DocumentEnvelope[])
        : [];
      return { available: true, documents };
    } catch (err) {
      this.resetConnection();
      return { available: false, documents: [], error: messageOf(err) };
    }
  }

  /** Fetch one document via `wm-document-read` (by id, or slug + optional kind). */
  async getDocument(input: GetDocumentInput): Promise<GetDocumentResult> {
    const client = await this.ensureConnected();
    if (!client) {
      return { available: false, document: null, error: 'Control plane not running' };
    }
    try {
      const result = await client.callTool({
        name: 'wm-document-read',
        arguments: { ...input },
      });
      const parsed = parseToolText(result) as { documents?: unknown } | null;
      const documents = Array.isArray(parsed?.documents)
        ? (parsed!.documents as DocumentEnvelope[])
        : [];
      const document = documents[0] ?? null;
      if (!document || !document.metadata || !document.kind) {
        return { available: true, document: null };
      }
      return { available: true, document };
    } catch (err) {
      this.resetConnection();
      return { available: false, document: null, error: messageOf(err) };
    }
  }

  /** Create a document via `wm-document-create`. Returns the created envelope. */
  async createDocument(input: CreateDocumentInput): Promise<WriteDocumentResult> {
    const client = await this.ensureConnected();
    if (!client) {
      return { available: false, document: null, error: 'Control plane not running' };
    }
    try {
      const args: Record<string, unknown> = { kind: input.kind };
      if (input.slug !== undefined) {
        args.slug = input.slug;
      }
      if (input.labels !== undefined) {
        args.labels = input.labels;
      }
      if (input.spec !== undefined) {
        args.spec = input.spec;
      }
      const result = await client.callTool({ name: 'wm-document-create', arguments: args });
      return interpretWriteResult(result);
    } catch (err) {
      this.resetConnection();
      return { available: false, document: null, error: messageOf(err) };
    }
  }

  /**
   * Update a document via `wm-document-update` (versioned compare-and-swap).
   * `spec` is a PARTIAL patch shallow-merged onto the current spec server-side.
   */
  async updateDocument(input: UpdateDocumentInput): Promise<WriteDocumentResult> {
    const client = await this.ensureConnected();
    if (!client) {
      return { available: false, document: null, error: 'Control plane not running' };
    }
    try {
      const args: Record<string, unknown> = {
        id: input.id,
        expectedResourceVersion: input.expectedResourceVersion,
      };
      if (input.spec !== undefined) {
        args.spec = input.spec;
      }
      if (input.slug !== undefined) {
        args.slug = input.slug;
      }
      if (input.labels !== undefined) {
        args.labels = input.labels;
      }
      const result = await client.callTool({ name: 'wm-document-update', arguments: args });
      return interpretWriteResult(result);
    } catch (err) {
      this.resetConnection();
      return { available: false, document: null, error: messageOf(err) };
    }
  }

  /**
   * Soft-delete (or, with `restore:true`, undelete) a document via
   * `wm-document-delete`. `expectedResourceVersion` is an optional CAS guard.
   */
  async deleteDocument(input: DeleteDocumentInput): Promise<WriteDocumentResult> {
    const client = await this.ensureConnected();
    if (!client) {
      return { available: false, document: null, error: 'Control plane not running' };
    }
    try {
      const args: Record<string, unknown> = { id: input.id };
      if (input.restore !== undefined) {
        args.restore = input.restore;
      }
      if (input.expectedResourceVersion !== undefined) {
        args.expectedResourceVersion = input.expectedResourceVersion;
      }
      const result = await client.callTool({ name: 'wm-document-delete', arguments: args });
      return interpretWriteResult(result);
    } catch (err) {
      this.resetConnection();
      return { available: false, document: null, error: messageOf(err) };
    }
  }

  // ----- Canonical tool catalog (command-widget single-source-of-truth) -----
  //
  // The command widget's local model is driven by the SAME tool registry an
  // agent sees. These thin wrappers expose the MCP `tools/list` and generic
  // `tools/call` so the widget can derive + dispatch its catalog at runtime
  // (WM 14.2.1 "derive-local-tools-from-canonical-registry") instead of a
  // hand-written table. Persistence still flows through the control-plane only.

  /**
   * Fetch the control-plane's canonical tool catalog via MCP `tools/list`.
   * Throws a {@link ControlPlaneClientError} when the daemon is unreachable or
   * the request fails (also resetting the connection so the next call
   * reconnects), mirroring the typed domain methods.
   */
  async listTools(): Promise<CanonicalToolDef[]> {
    const client = await this.ensureConnected();
    if (!client) {
      throw new ControlPlaneClientError('Control plane not running');
    }
    let res: unknown;
    try {
      res = await client.listTools();
    } catch (err) {
      this.resetConnection();
      throw new ControlPlaneClientError(messageOf(err));
    }
    const tools = (res as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) {
      return [];
    }
    return tools
      .map((t) => {
        const tool = t as { name?: unknown; description?: unknown; inputSchema?: unknown };
        return {
          name: typeof tool.name === 'string' ? tool.name : '',
          description: typeof tool.description === 'string' ? tool.description : undefined,
          inputSchema:
            tool.inputSchema && typeof tool.inputSchema === 'object'
              ? (tool.inputSchema as Record<string, unknown>)
              : undefined,
        };
      })
      .filter((t) => t.name.length > 0);
  }

  /**
   * Generic `tools/call` used by the command widget's generic dispatch: invoke
   * any canonical `ws-*`/`wm-*` tool by name. Never throws — a dead daemon or an
   * `isError` result comes back as `{ ok:false, error }`; a success parses the
   * tool's single text content block as JSON into `result`.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallOutcome> {
    const client = await this.ensureConnected();
    if (!client) {
      return { ok: false, error: 'Control plane not running' };
    }
    let result: unknown;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (err) {
      this.resetConnection();
      return { ok: false, error: messageOf(err) };
    }
    if ((result as { isError?: unknown }).isError === true) {
      return { ok: false, error: errorTextOf(result) };
    }
    const parsed = parseToolText(result);
    return { ok: true, result: parsed ?? result };
  }

  // ----- CommandJournal (per-workstream command-widget chat) ----------------
  //
  // Thin typed wrappers over the GENERIC `wm-document-*` surface — the POC only
  // needs create + read-by-kind, so no bespoke `ws-commandjournal-*` tools are
  // added. Persistence goes through the control-plane client ONLY (guardrail).

  /**
   * Persist one command-widget request/response cycle as a `CommandJournal`
   * document (via `wm-document-create`). Returns the write result; on success
   * the `document` envelope carries BOTH `metadata.id` and
   * `metadata.resourceVersion`, so the caller can drive the two-phase update
   * without an extra read. The caller decides how to surface a failure
   * (journaling is best-effort).
   */
  async commandJournalCreate(spec: CommandJournalSpec): Promise<WriteDocumentResult> {
    return this.createDocument({
      kind: COMMAND_JOURNAL_KIND,
      spec: spec as unknown as Record<string, unknown>,
    });
  }

  /**
   * Update a `CommandJournal` document (two-phase write, phase 2) via the
   * generic `wm-document-update` compare-and-swap. `spec` is a PARTIAL patch
   * shallow-merged onto the current spec server-side, so passing `{ status,
   * response }` overwrites those top-level keys while `workstream`/`request`
   * carry through.
   *
   * The CAS needs an `expectedResourceVersion`: pass the version the create
   * returned to skip a read. On a version conflict (a concurrent write bumped
   * the row) this does ONE re-read + retry with the fresh version; any other
   * rejection is returned as-is. Journaling is best-effort, so the caller logs
   * and moves on rather than throwing.
   */
  async commandJournalUpdate(
    id: string,
    spec: Partial<CommandJournalSpec>,
    expectedResourceVersion?: number,
  ): Promise<WriteDocumentResult> {
    const patch = spec as unknown as Record<string, unknown>;
    // Resolve the version to CAS against: the caller's (from create) or a read.
    let version = expectedResourceVersion;
    if (version === undefined) {
      const current = await this.getDocument({ id });
      if (!current.available) {
        return { available: false, document: null, error: current.error };
      }
      if (!current.document) {
        return { available: true, document: null, error: `CommandJournal ${id} not found` };
      }
      version = current.document.metadata.resourceVersion;
    }

    const first = await this.updateDocument({ id, expectedResourceVersion: version, spec: patch });
    // Only a version conflict is worth retrying (a concurrent bump); every other
    // rejection — not-found, validation — would just fail again.
    const isConflict =
      first.available && !first.document && /conflict/i.test(first.error ?? '');
    if (!isConflict) {
      return first;
    }
    const reread = await this.getDocument({ id });
    if (!reread.available || !reread.document) {
      return first;
    }
    return this.updateDocument({
      id,
      expectedResourceVersion: reread.document.metadata.resourceVersion,
      spec: patch,
    });
  }

  /**
   * Read this scope's command-widget chat: list `CommandJournal` docs, filter to
   * `workstream`, and return them OLDEST→NEWEST (replay order). Returns `[]` when
   * the daemon is down or the read fails (journaling/replay is non-critical).
   */
  async commandJournalReadByWorkstream(workstream: string): Promise<CommandJournalDoc[]> {
    const result = await this.listDocuments(COMMAND_JOURNAL_KIND);
    if (!result.available) {
      return [];
    }
    return filterAndSortJournals(result.documents, workstream);
  }

  // ----- Workstream domain API (`ws-*`) -------------------------------------
  //
  // Typed wrappers over the control-plane's Workstream kind API. Each parses the
  // tool's JSON text result (`result.content[0].text` → JSON.parse) into the
  // owned {@link Workstream} shape and THROWS {@link ControlPlaneClientError} on
  // a dead daemon, a dropped connection, or an `isError` tool result — so the
  // extension-host consumers get the mapped value directly (no `available`
  // wrapper) and surface failures through their existing try/catch paths.

  /**
   * Call a `ws-*` (namespaced domain) tool and return its raw result, throwing a
   * typed {@link ControlPlaneClientError} when the daemon is unreachable, the
   * transport drops (also resetting the connection so the next call reconnects),
   * or the tool result is flagged `isError`.
   */
  private async callDomainTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const client = await this.ensureConnected();
    if (!client) {
      throw new ControlPlaneClientError('Control plane not running');
    }
    let result: unknown;
    try {
      result = await client.callTool({ name, arguments: args });
    } catch (err) {
      this.resetConnection();
      throw new ControlPlaneClientError(messageOf(err));
    }
    if ((result as { isError?: unknown }).isError === true) {
      throw new ControlPlaneClientError(errorTextOf(result));
    }
    return result;
  }

  /** Parse a `ws-*` success result into the owned {@link Workstream} shape. */
  private parseWorkstream(result: unknown): Workstream {
    const parsed = parseToolText(result) as Workstream | null;
    if (!parsed || typeof parsed.id !== 'string') {
      throw new ControlPlaneClientError('Malformed control-plane workstream response');
    }
    return parsed;
  }

  /**
   * Read workstreams via `ws-workstream-read`. A by-slug/id read yields a 0-or-1
   * element array; list mode (no slug/id) returns all live workstreams, optionally
   * filtered by `query` / capped by `limit`.
   */
  async wsRead(input: WsReadInput = {}): Promise<Workstream[]> {
    const args: Record<string, unknown> = {};
    if (input.slug !== undefined) {
      args.slug = input.slug;
    }
    if (input.id !== undefined) {
      args.id = input.id;
    }
    if (input.query !== undefined) {
      args.query = input.query;
    }
    if (input.limit !== undefined) {
      args.limit = input.limit;
    }
    const result = await this.callDomainTool('ws-workstream-read', args);
    const parsed = parseToolText(result) as { workstreams?: unknown } | null;
    const list = Array.isArray(parsed?.workstreams) ? parsed!.workstreams : [];
    return list as Workstream[];
  }

  /** Create a workstream via `ws-workstream-create`. Returns the created workstream. */
  async wsCreate(input: WsCreateInput): Promise<Workstream> {
    const args: Record<string, unknown> = { title: input.title };
    if (input.slug !== undefined) {
      args.slug = input.slug;
    }
    if (input.status !== undefined) {
      args.status = input.status;
    }
    if (input.closure !== undefined) {
      args.closure = input.closure;
    }
    return this.parseWorkstream(await this.callDomainTool('ws-workstream-create', args));
  }

  /**
   * Update a workstream via `ws-workstream-update` (identified by `slug`; only the
   * changed fields are sent). The control-plane reads the current doc for its CAS guard.
   */
  async wsUpdate(input: WsUpdateInput): Promise<Workstream> {
    const args: Record<string, unknown> = { slug: input.slug };
    if (input.title !== undefined) {
      args.title = input.title;
    }
    if (input.status !== undefined) {
      args.status = input.status;
    }
    if (input.closure !== undefined) {
      args.closure = input.closure;
    }
    return this.parseWorkstream(await this.callDomainTool('ws-workstream-update', args));
  }

  /**
   * Soft-delete (or, with `restore: true`, undelete) a workstream via
   * `ws-workstream-delete` (identified by `slug`). Returns `{ ok, slug }`.
   */
  async wsDelete(input: WsDeleteInput): Promise<{ ok: boolean; slug: string }> {
    const args: Record<string, unknown> = { slug: input.slug };
    if (input.restore !== undefined) {
      args.restore = input.restore;
    }
    const result = await this.callDomainTool('ws-workstream-delete', args);
    const parsed = parseToolText(result) as { ok?: unknown; slug?: unknown } | null;
    return {
      ok: parsed?.ok === true,
      slug: typeof parsed?.slug === 'string' ? parsed.slug : input.slug,
    };
  }

  // ----- Topic domain API (`ws-topic-*`) ------------------------------------
  //
  // Typed wrappers over the control-plane's Topic kind API (WM 13.0
  // "topic-consumer-repoint"), mirroring the ws-workstream-* methods above: each
  // parses the tool's JSON text result into the owned {@link Topic} shape and
  // THROWS {@link ControlPlaneClientError} on a dead daemon, a dropped
  // connection, or an `isError` tool result. Workstream membership + parents are
  // flat slug arrays on the returned Topic; attach/detach edit membership.

  /** Parse a `ws-topic-*` success result into the owned {@link Topic} shape. */
  private parseTopic(result: unknown): Topic {
    const parsed = parseToolText(result) as Topic | null;
    if (!parsed || typeof parsed.id !== 'string') {
      throw new ControlPlaneClientError('Malformed control-plane topic response');
    }
    // Defensive defaults for the flat slug-array spec refs (an older/partial
    // serialization may omit them).
    if (!Array.isArray(parsed.workstreams)) {
      parsed.workstreams = [];
    }
    if (!Array.isArray(parsed.focusedWorkstreams)) {
      parsed.focusedWorkstreams = [];
    }
    return parsed;
  }

  /**
   * Read topics via `ws-topic-read`. A by-slug/id read yields a 0-or-1 element
   * array; list mode (no slug/id) returns all live topics, optionally filtered
   * by `query` (substring), `workstream` (membership), and capped by `limit`.
   */
  async topicRead(input: TopicReadInput = {}): Promise<Topic[]> {
    const args: Record<string, unknown> = {};
    if (input.slug !== undefined) {
      args.slug = input.slug;
    }
    if (input.id !== undefined) {
      args.id = input.id;
    }
    if (input.query !== undefined) {
      args.query = input.query;
    }
    if (input.workstream !== undefined) {
      args.workstream = input.workstream;
    }
    if (input.limit !== undefined) {
      args.limit = input.limit;
    }
    const result = await this.callDomainTool('ws-topic-read', args);
    const parsed = parseToolText(result) as { topics?: unknown } | null;
    const list = Array.isArray(parsed?.topics) ? parsed!.topics : [];
    return list as Topic[];
  }

  /** Create a topic via `ws-topic-create`. Returns the created topic. */
  async topicCreate(input: TopicCreateInput): Promise<Topic> {
    const args: Record<string, unknown> = { title: input.title };
    if (input.slug !== undefined) {
      args.slug = input.slug;
    }
    if (input.body !== undefined) {
      args.body = input.body;
    }
    if (input.status !== undefined) {
      args.status = input.status;
    }
    if (input.topicType !== undefined) {
      args.topicType = input.topicType;
    }
    if (input.parents !== undefined) {
      args.parents = input.parents;
    }
    if (input.workstreams !== undefined) {
      args.workstreams = input.workstreams;
    }
    if (input.focusedWorkstreams !== undefined) {
      args.focusedWorkstreams = input.focusedWorkstreams;
    }
    return this.parseTopic(await this.callDomainTool('ws-topic-create', args));
  }

  /**
   * Update a topic via `ws-topic-update` (identified by `slug`; only the changed
   * fields are sent). The control-plane reads the current doc for its CAS guard.
   * Note `parents` / `workstreams` are REPLACEMENT arrays when provided.
   */
  async topicUpdate(input: TopicUpdateInput): Promise<Topic> {
    const args: Record<string, unknown> = { slug: input.slug };
    if (input.title !== undefined) {
      args.title = input.title;
    }
    if (input.body !== undefined) {
      args.body = input.body;
    }
    if (input.status !== undefined) {
      args.status = input.status;
    }
    if (input.topicType !== undefined) {
      args.topicType = input.topicType;
    }
    if (input.parents !== undefined) {
      args.parents = input.parents;
    }
    if (input.workstreams !== undefined) {
      args.workstreams = input.workstreams;
    }
    if (input.focusedWorkstreams !== undefined) {
      args.focusedWorkstreams = input.focusedWorkstreams;
    }
    return this.parseTopic(await this.callDomainTool('ws-topic-update', args));
  }

  /**
   * Soft-delete (or, with `restore: true`, undelete) a topic via
   * `ws-topic-delete` (identified by `slug`). Returns `{ ok, slug }`.
   */
  async topicDelete(input: TopicDeleteInput): Promise<{ ok: boolean; slug: string }> {
    const args: Record<string, unknown> = { slug: input.slug };
    if (input.restore !== undefined) {
      args.restore = input.restore;
    }
    const result = await this.callDomainTool('ws-topic-delete', args);
    const parsed = parseToolText(result) as { ok?: unknown; slug?: unknown } | null;
    return {
      ok: parsed?.ok === true,
      slug: typeof parsed?.slug === 'string' ? parsed.slug : input.slug,
    };
  }

  // ----- TopicType domain API (`ws-topictype-*`) ----------------------------
  //
  // Typed wrappers over the control-plane's TopicType kind API, mirroring the
  // ws-topic-* methods: each parses the tool's JSON text result into the owned
  // {@link TopicType} shape and THROWS {@link ControlPlaneClientError} on a dead
  // daemon, a dropped connection, or an `isError` tool result. Used to render +
  // SAVE `working-memory:/topic-type/<slug>.md` docs control-plane-only.

  /**
   * Read topic types via `ws-topictype-read`. A by-slug/id read yields a
   * 0-or-1 element array; list mode (no slug/id) returns all live topic types.
   */
  async topicTypeRead(input: TopicTypeReadInput = {}): Promise<TopicType[]> {
    const args: Record<string, unknown> = {};
    if (input.slug !== undefined) {
      args.slug = input.slug;
    }
    if (input.id !== undefined) {
      args.id = input.id;
    }
    if (input.query !== undefined) {
      args.query = input.query;
    }
    if (input.limit !== undefined) {
      args.limit = input.limit;
    }
    const result = await this.callDomainTool('ws-topictype-read', args);
    const parsed = parseToolText(result) as { topicTypes?: unknown } | null;
    const list = Array.isArray(parsed?.topicTypes) ? parsed!.topicTypes : [];
    return list as TopicType[];
  }

  /** Create a topic type via `ws-topictype-create`. Returns the created type. */
  async topicTypeCreate(input: TopicTypeCreateInput): Promise<TopicType> {
    const args: Record<string, unknown> = {
      label: input.label,
      icon: input.icon,
      description: input.description,
    };
    if (input.slug !== undefined) {
      args.slug = input.slug;
    }
    if (input.body_template !== undefined) {
      args.body_template = input.body_template;
    }
    return this.parseTopicType(
      await this.callDomainTool('ws-topictype-create', args),
    );
  }

  /**
   * Update a topic type via `ws-topictype-update` (identified by `slug`; only
   * the changed fields are sent). The control-plane reads the current doc for
   * its CAS guard. Returns the updated topic type.
   */
  async topicTypeUpdate(input: TopicTypeUpdateInput): Promise<TopicType> {
    const args: Record<string, unknown> = { slug: input.slug };
    if (input.label !== undefined) {
      args.label = input.label;
    }
    if (input.icon !== undefined) {
      args.icon = input.icon;
    }
    if (input.description !== undefined) {
      args.description = input.description;
    }
    if (input.body_template !== undefined) {
      args.body_template = input.body_template;
    }
    return this.parseTopicType(
      await this.callDomainTool('ws-topictype-update', args),
    );
  }

  /** Parse a `ws-topictype-*` success result into the owned {@link TopicType} shape. */
  private parseTopicType(result: unknown): TopicType {
    const parsed = parseToolText(result) as TopicType | null;
    if (!parsed || typeof parsed.id !== 'string') {
      throw new ControlPlaneClientError(
        'Malformed control-plane topic type response',
      );
    }
    return parsed;
  }

  // ----- Config domain API (`ws-config-*`) ----------------------------------
  //
  // Typed wrappers over the control-plane's Config kind API, mirroring the
  // ws-topictype-* methods: each parses the tool's JSON text result into the
  // owned {@link Config} shape and THROWS {@link ControlPlaneClientError} on a
  // dead daemon, a dropped connection, or an `isError` tool result. A configmap
  // is a named bag of string key-value pairs referenced by a nanite for env
  // injection.

  /**
   * Read configs via `ws-config-read`. A by-slug/id read yields a 0-or-1 element
   * array; list mode (no slug/id) returns all live configs.
   */
  async configRead(input: ConfigReadInput = {}): Promise<Config[]> {
    const args: Record<string, unknown> = {};
    if (input.slug !== undefined) {
      args.slug = input.slug;
    }
    if (input.id !== undefined) {
      args.id = input.id;
    }
    if (input.query !== undefined) {
      args.query = input.query;
    }
    if (input.limit !== undefined) {
      args.limit = input.limit;
    }
    const result = await this.callDomainTool('ws-config-read', args);
    const parsed = parseToolText(result) as { configs?: unknown } | null;
    const list = Array.isArray(parsed?.configs) ? parsed!.configs : [];
    return list as Config[];
  }

  /** Create a config via `ws-config-create`. Returns the created config. */
  async configCreate(input: ConfigCreateInput): Promise<Config> {
    const args: Record<string, unknown> = { data: input.data };
    if (input.slug !== undefined) {
      args.slug = input.slug;
    }
    if (input.name !== undefined) {
      args.name = input.name;
    }
    if (input.status !== undefined) {
      args.status = input.status;
    }
    return this.parseConfig(await this.callDomainTool('ws-config-create', args));
  }

  /**
   * Update a config via `ws-config-update` (identified by `slug`; `data` is
   * merged onto the existing map, `name`/`status` replace when provided). The
   * control-plane reads the current doc for its CAS guard. Returns the updated
   * config.
   */
  async configUpdate(input: ConfigUpdateInput): Promise<Config> {
    const args: Record<string, unknown> = { slug: input.slug };
    if (input.name !== undefined) {
      args.name = input.name;
    }
    if (input.data !== undefined) {
      args.data = input.data;
    }
    if (input.status !== undefined) {
      args.status = input.status;
    }
    return this.parseConfig(await this.callDomainTool('ws-config-update', args));
  }

  /**
   * Soft-delete (or, with `restore: true`, undelete) a config via
   * `ws-config-delete` (identified by `slug`). Returns `{ ok, slug }`.
   */
  async configDelete(input: ConfigDeleteInput): Promise<{ ok: boolean; slug: string }> {
    const args: Record<string, unknown> = { slug: input.slug };
    if (input.restore !== undefined) {
      args.restore = input.restore;
    }
    const result = await this.callDomainTool('ws-config-delete', args);
    const parsed = parseToolText(result) as { ok?: unknown; slug?: unknown } | null;
    return {
      ok: parsed?.ok === true,
      slug: typeof parsed?.slug === 'string' ? parsed.slug : input.slug,
    };
  }

  /** Parse a `ws-config-*` success result into the owned {@link Config} shape. */
  private parseConfig(result: unknown): Config {
    const parsed = parseToolText(result) as Config | null;
    if (!parsed || typeof parsed.id !== 'string') {
      throw new ControlPlaneClientError('Malformed control-plane config response');
    }
    return parsed;
  }

  /**
   * Attach a workstream to a topic's membership (idempotent). Topic↔workstream
   * membership is edited via `ws-topic-update` over the topic's
   * `spec.workstreams` array, so this is a read-modify-write: read the current
   * topic, add the workstream if absent, then update. Returns the updated topic.
   */
  async topicAttachWorkstream(input: TopicAttachWorkstreamInput): Promise<Topic> {
    const [topic] = await this.topicRead({ slug: input.slug });
    if (!topic) {
      throw new ControlPlaneClientError(`Unknown topic slug: ${input.slug}`);
    }
    const next = topic.workstreams.includes(input.workstream)
      ? topic.workstreams
      : [...topic.workstreams, input.workstream];
    return this.topicUpdate({ slug: input.slug, workstreams: next });
  }

  /**
   * Detach a workstream from a topic's membership (idempotent). Topic↔workstream
   * membership is edited via `ws-topic-update` over the topic's
   * `spec.workstreams` array, so this is a read-modify-write: read the current
   * topic, drop the workstream, then update. Filtering an absent value is a
   * no-op. Returns the updated topic.
   */
  async topicDetachWorkstream(input: TopicDetachWorkstreamInput): Promise<Topic> {
    const [topic] = await this.topicRead({ slug: input.slug });
    if (!topic) {
      throw new ControlPlaneClientError(`Unknown topic slug: ${input.slug}`);
    }
    const next = topic.workstreams.filter((w) => w !== input.workstream);
    return this.topicUpdate({ slug: input.slug, workstreams: next });
  }

  /**
   * Pin (focus) a topic in a workstream (idempotent). A focused topic must be a
   * member, so this read-modify-write ensures `workstream` is present in BOTH
   * the topic's `workstreams` membership (added if absent) AND its
   * `focusedWorkstreams` subset (added if absent), then updates both arrays.
   * Returns the updated topic.
   */
  async topicSetFocus(input: TopicSetFocusInput): Promise<Topic> {
    const [topic] = await this.topicRead({ slug: input.slug });
    if (!topic) {
      throw new ControlPlaneClientError(`Unknown topic slug: ${input.slug}`);
    }
    const workstreams = topic.workstreams.includes(input.workstream)
      ? topic.workstreams
      : [...topic.workstreams, input.workstream];
    const focusedWorkstreams = topic.focusedWorkstreams.includes(input.workstream)
      ? topic.focusedWorkstreams
      : [...topic.focusedWorkstreams, input.workstream];
    return this.topicUpdate({ slug: input.slug, workstreams, focusedWorkstreams });
  }

  /**
   * Unpin (clear focus for) a topic in a workstream (idempotent). Removes
   * `workstream` from the topic's `focusedWorkstreams` subset ONLY — membership
   * in `workstreams` is intentionally KEPT (unfocusing ≠ detaching). Clearing an
   * absent value is a no-op. Returns the updated topic.
   */
  async topicClearFocus(input: TopicClearFocusInput): Promise<Topic> {
    const [topic] = await this.topicRead({ slug: input.slug });
    if (!topic) {
      throw new ControlPlaneClientError(`Unknown topic slug: ${input.slug}`);
    }
    const focusedWorkstreams = topic.focusedWorkstreams.filter(
      (w) => w !== input.workstream,
    );
    return this.topicUpdate({ slug: input.slug, focusedWorkstreams });
  }

  // ----- Alert domain API (`ws-alert-read`) ---------------------------------
  //
  // Read-only wrapper over the control-plane's Alert kind read tool (WM 13.0
  // panel-alert-bubbles): the panel aggregates open-alert counts for its
  // control-plane cards/topics from THIS list rather than the journal
  // `AlertsStore`, so alerts authored through the control-plane (`ws-alert-*`)
  // actually surface on the bubbles. Parses the uniform `{ count, alerts }`
  // result into the owned {@link Alert} shape and THROWS
  // {@link ControlPlaneClientError} on a dead daemon / dropped connection /
  // `isError` result, mirroring {@link topicRead}.

  /**
   * Read alerts via `ws-alert-read`. A by-id read yields a 0-or-1 element array;
   * list mode (no id) returns all live alerts, optionally filtered by `query`
   * (substring) and capped by `limit`.
   */
  async alertRead(input: AlertReadInput = {}): Promise<Alert[]> {
    const args: Record<string, unknown> = {};
    if (input.id !== undefined) {
      args.id = input.id;
    }
    if (input.query !== undefined) {
      args.query = input.query;
    }
    if (input.limit !== undefined) {
      args.limit = input.limit;
    }
    const result = await this.callDomainTool('ws-alert-read', args);
    const parsed = parseToolText(result) as { alerts?: unknown } | null;
    const list = Array.isArray(parsed?.alerts) ? parsed!.alerts : [];
    return list as Alert[];
  }

  /**
   * Parse a `ws-alert-*` success result — a single mapped alert object (the
   * control-plane `Alert` POCO) — into the owned {@link Alert} shape, applying
   * the same defensive field defaults as the control-plane's projection so the
   * returned value is always well-formed. THROWS when the result is malformed.
   */
  private parseAlert(result: unknown): Alert {
    const parsed = parseToolText(result) as Partial<Alert> | null;
    if (!parsed || typeof parsed.id !== 'string') {
      throw new ControlPlaneClientError('Malformed control-plane alert response');
    }
    const status =
      parsed.status === 'alert' ||
      parsed.status === 'informational' ||
      parsed.status === 'closed'
        ? parsed.status
        : 'alert';
    return {
      id: parsed.id,
      slug: typeof parsed.slug === 'string' ? parsed.slug : null,
      title: typeof parsed.title === 'string' ? parsed.title : '',
      description: typeof parsed.description === 'string' ? parsed.description : '',
      recommended_action:
        typeof parsed.recommended_action === 'string' ? parsed.recommended_action : '',
      status,
      dedupe_key: typeof parsed.dedupe_key === 'string' ? parsed.dedupe_key : null,
      created_by: typeof parsed.created_by === 'string' ? parsed.created_by : 'system',
      topics: Array.isArray(parsed.topics)
        ? parsed.topics.filter((t): t is string => typeof t === 'string')
        : [],
      created_at: typeof parsed.created_at === 'number' ? parsed.created_at : 0,
      updated_at: typeof parsed.updated_at === 'number' ? parsed.updated_at : 0,
      resourceVersion:
        typeof parsed.resourceVersion === 'number' ? parsed.resourceVersion : 0,
    };
  }

  /**
   * Update an alert via `ws-alert-update` (identified by `id`; only the provided
   * fields are sent). The control-plane reads the current doc for its CAS guard,
   * merges + re-validates the patch, then writes. Returns the updated alert.
   */
  async alertUpdate(input: AlertUpdateInput): Promise<Alert> {
    const args: Record<string, unknown> = { id: input.id };
    if (input.status !== undefined) {
      args.status = input.status;
    }
    if (input.title !== undefined) {
      args.title = input.title;
    }
    if (input.description !== undefined) {
      args.description = input.description;
    }
    if (input.recommended_action !== undefined) {
      args.recommended_action = input.recommended_action;
    }
    if (input.dedupe_key !== undefined) {
      args.dedupe_key = input.dedupe_key;
    }
    if (input.created_by !== undefined) {
      args.created_by = input.created_by;
    }
    if (input.topics !== undefined) {
      args.topics = input.topics;
    }
    return this.parseAlert(await this.callDomainTool('ws-alert-update', args));
  }

  /**
   * Create an alert via `ws-alert-create` (WM 14.2.1 "poc-command-widget" — the
   * right-rail agentic loop needs to raise alerts, and the read-only alert
   * wrapper predates that). Only `description` is required; the rest default
   * server-side. Returns the created alert (its `id` is the update/delete handle).
   */
  async alertCreate(input: AlertCreateInput): Promise<Alert> {
    const args: Record<string, unknown> = { description: input.description };
    if (input.title !== undefined) {
      args.title = input.title;
    }
    if (input.recommended_action !== undefined) {
      args.recommended_action = input.recommended_action;
    }
    if (input.status !== undefined) {
      args.status = input.status;
    }
    if (input.dedupe_key !== undefined) {
      args.dedupe_key = input.dedupe_key;
    }
    if (input.created_by !== undefined) {
      args.created_by = input.created_by;
    }
    if (input.topics !== undefined) {
      args.topics = input.topics;
    }
    return this.parseAlert(await this.callDomainTool('ws-alert-create', args));
  }

  /**
   * Soft-delete (or, with `restore: true`, undelete) an alert via
   * `ws-alert-delete` (identified by `id`). Returns `{ ok, id }`.
   */
  async alertDelete(input: AlertDeleteInput): Promise<{ ok: boolean; id: string }> {
    const args: Record<string, unknown> = { id: input.id };
    if (input.restore !== undefined) {
      args.restore = input.restore;
    }
    const result = await this.callDomainTool('ws-alert-delete', args);
    const parsed = parseToolText(result) as { ok?: unknown; id?: unknown } | null;
    return {
      ok: parsed?.ok === true,
      id: typeof parsed?.id === 'string' ? parsed.id : input.id,
    };
  }

  // ----- Nanite Template domain API (`ws-nanitetemplate-*`) -----------------
  //
  // Typed wrappers over the control-plane's NaniteTemplate kind API (slug-based,
  // mirroring ws-topic-*). Each parses the tool's JSON text result into the
  // owned {@link NaniteTemplate} shape and THROWS {@link ControlPlaneClientError}
  // on a dead daemon / dropped connection / `isError` result.

  /** Parse a `ws-nanitetemplate-*` success result into the owned {@link NaniteTemplate}. */
  private parseNaniteTemplate(result: unknown): NaniteTemplate {
    const parsed = parseToolText(result) as NaniteTemplate | null;
    if (!parsed || typeof parsed.id !== 'string') {
      throw new ControlPlaneClientError('Malformed control-plane nanite template response');
    }
    return parsed;
  }

  /** Read nanite templates via `ws-nanitetemplate-read` (by slug/id, or list). */
  async naniteTemplateRead(input: NaniteTemplateReadInput = {}): Promise<NaniteTemplate[]> {
    const args: Record<string, unknown> = {};
    if (input.slug !== undefined) {
      args.slug = input.slug;
    }
    if (input.id !== undefined) {
      args.id = input.id;
    }
    if (input.query !== undefined) {
      args.query = input.query;
    }
    if (input.limit !== undefined) {
      args.limit = input.limit;
    }
    const result = await this.callDomainTool('ws-nanitetemplate-read', args);
    const parsed = parseToolText(result) as { templates?: unknown } | null;
    const list = Array.isArray(parsed?.templates) ? parsed!.templates : [];
    return list as NaniteTemplate[];
  }

  /** Create a nanite template via `ws-nanitetemplate-create`. */
  async naniteTemplateCreate(input: NaniteTemplateCreateInput): Promise<NaniteTemplate> {
    const args: Record<string, unknown> = { title: input.title };
    for (const key of [
      'slug',
      'triggerPhrase',
      'instructions',
      'executionSettings',
      'toolAllowlist',
      'toolDenylist',
      'allowRunWithoutHuman',
      'inputSchema',
      'outputSchema',
      'acceptanceCriteria',
      'acceptanceThreshold',
      'enabled',
    ] as const) {
      if (input[key] !== undefined) {
        args[key] = input[key];
      }
    }
    return this.parseNaniteTemplate(
      await this.callDomainTool('ws-nanitetemplate-create', args),
    );
  }

  /** Update a nanite template via `ws-nanitetemplate-update` (by slug). */
  async naniteTemplateUpdate(input: NaniteTemplateUpdateInput): Promise<NaniteTemplate> {
    const args: Record<string, unknown> = { slug: input.slug };
    for (const key of [
      'title',
      'triggerPhrase',
      'instructions',
      'executionSettings',
      'toolAllowlist',
      'toolDenylist',
      'allowRunWithoutHuman',
      'inputSchema',
      'outputSchema',
      'acceptanceCriteria',
      'acceptanceThreshold',
      'enabled',
    ] as const) {
      if (input[key] !== undefined) {
        args[key] = input[key];
      }
    }
    return this.parseNaniteTemplate(
      await this.callDomainTool('ws-nanitetemplate-update', args),
    );
  }

  /** Soft-delete (or restore) a nanite template via `ws-nanitetemplate-delete` (by slug). */
  async naniteTemplateDelete(
    input: NaniteTemplateDeleteInput,
  ): Promise<{ ok: boolean; slug: string }> {
    const args: Record<string, unknown> = { slug: input.slug };
    if (input.restore !== undefined) {
      args.restore = input.restore;
    }
    const result = await this.callDomainTool('ws-nanitetemplate-delete', args);
    const parsed = parseToolText(result) as { ok?: unknown; slug?: unknown } | null;
    return {
      ok: parsed?.ok === true,
      slug: typeof parsed?.slug === 'string' ? parsed.slug : input.slug,
    };
  }

  // ----- Nanite domain API (`ws-nanite-*`) ----------------------------------
  //
  // Typed wrappers over the control-plane's Nanite kind API — ONE execution
  // instance of a NaniteTemplate (id-based, mirroring ws-alert-*). `run`
  // transitions the lifecycle phase; `update` patches only the mutable
  // `configs` + `request` (workstream + inputTopic + lifecycle stay immutable).

  /** Parse a `ws-nanite-*` success result into the owned {@link Nanite}. */
  private parseNanite(result: unknown): Nanite {
    const parsed = parseToolText(result) as Nanite | null;
    if (!parsed || typeof parsed.id !== 'string') {
      throw new ControlPlaneClientError('Malformed control-plane nanite response');
    }
    return parsed;
  }

  /** Read nanites via `ws-nanite-read` (by id, or list filtered by input topic / workstream). */
  async naniteRead(input: NaniteReadInput = {}): Promise<Nanite[]> {
    const args: Record<string, unknown> = {};
    if (input.id !== undefined) {
      args.id = input.id;
    }
    if (input.inputTopic !== undefined) {
      args.inputTopic = input.inputTopic;
    }
    if (input.workstream !== undefined) {
      args.workstream = input.workstream;
    }
    if (input.phase !== undefined) {
      args.phase = input.phase;
    }
    if (input.limit !== undefined) {
      args.limit = input.limit;
    }
    const result = await this.callDomainTool('ws-nanite-read', args);
    const parsed = parseToolText(result) as { nanites?: unknown } | null;
    const list = Array.isArray(parsed?.nanites) ? parsed!.nanites : [];
    return list as Nanite[];
  }

  /** Create a nanite via `ws-nanite-create` (requires workstream + inputTopic). */
  async naniteCreate(input: NaniteCreateInput): Promise<Nanite> {
    const args: Record<string, unknown> = {
      workstream: input.workstream,
    };
    if (input.inputTopic !== undefined) {
      args.inputTopic = input.inputTopic;
    }
    if (input.templateId !== undefined) {
      args.templateId = input.templateId;
    }
    if (input.configs !== undefined) {
      args.configs = input.configs;
    }
    if (input.request !== undefined) {
      args.request = input.request;
    }
    return this.parseNanite(await this.callDomainTool('ws-nanite-create', args));
  }

  /**
   * Patch a nanite's mutable fields via `ws-nanite-update` (by id). Only
   * `configs` + `request` are patchable; `workstream`, `inputTopic`, and all
   * lifecycle/result fields are immutable. Optionally supply
   * `expectedResourceVersion` for a compare-and-swap guard.
   */
  async naniteUpdate(input: NaniteUpdateInput): Promise<Nanite> {
    const args: Record<string, unknown> = { id: input.id };
    if (input.expectedResourceVersion !== undefined) {
      args.expectedResourceVersion = input.expectedResourceVersion;
    }
    if (input.configs !== undefined) {
      args.configs = input.configs;
    }
    if (input.request !== undefined) {
      args.request = input.request;
    }
    return this.parseNanite(await this.callDomainTool('ws-nanite-update', args));
  }

  /** Kick off (or finish) a nanite via `ws-nanite-run`. */
  async naniteRun(input: NaniteRunInput): Promise<Nanite> {
    const args: Record<string, unknown> = { id: input.id };
    if (input.approved !== undefined) {
      args.approved = input.approved;
    }
    if (input.begin !== undefined) {
      args.begin = input.begin;
    }
    if (input.outcome !== undefined) {
      args.outcome = input.outcome;
    }
    if (input.error !== undefined) {
      args.error = input.error;
    }
    if (input.latestJournalId !== undefined) {
      args.latestJournalId = input.latestJournalId;
    }
    if (input.reset !== undefined) {
      args.reset = input.reset;
    }
    return this.parseNanite(await this.callDomainTool('ws-nanite-run', args));
  }

  /** Soft-delete (or restore) a nanite via `ws-nanite-delete` (by id). */
  async naniteDelete(input: NaniteDeleteInput): Promise<{ ok: boolean; id: string }> {
    const args: Record<string, unknown> = { id: input.id };
    if (input.restore !== undefined) {
      args.restore = input.restore;
    }
    const result = await this.callDomainTool('ws-nanite-delete', args);
    const parsed = parseToolText(result) as { ok?: unknown; id?: unknown } | null;
    return {
      ok: parsed?.ok === true,
      id: typeof parsed?.id === 'string' ? parsed.id : input.id,
    };
  }

  // ----- Nanite Journal domain API (`ws-nanitejournal-*`) -------------------
  //
  // Typed wrappers over the control-plane's NaniteJournal kind API — ONE
  // immutable record per nanite run. A run appends a journal (create) and the
  // nanite keeps only a light `latestJournalId` pointer; records are read by id
  // or listed by `naniteId` (a nanite's run history, newest-first).

  /** Parse a `ws-nanitejournal-*` success result into the owned {@link NaniteJournal}. */
  private parseNaniteJournal(result: unknown): NaniteJournal {
    const parsed = parseToolText(result) as NaniteJournal | null;
    if (!parsed || typeof parsed.id !== 'string') {
      throw new ControlPlaneClientError('Malformed control-plane nanite journal response');
    }
    return parsed;
  }

  /** Append one immutable run record via `ws-nanitejournal-create`. */
  async naniteJournalCreate(input: NaniteJournalCreateInput): Promise<NaniteJournal> {
    const args: Record<string, unknown> = { naniteId: input.naniteId };
    if (input.workstream !== undefined) {
      args.workstream = input.workstream;
    }
    if (input.inputTopic !== undefined) {
      args.inputTopic = input.inputTopic;
    }
    if (input.status !== undefined) {
      args.status = input.status;
    }
    if (input.prompt !== undefined) {
      args.prompt = input.prompt;
    }
    if (input.execution !== undefined) {
      args.execution = input.execution;
    }
    if (input.results !== undefined) {
      args.results = input.results;
    }
    return this.parseNaniteJournal(await this.callDomainTool('ws-nanitejournal-create', args));
  }

  /**
   * Read nanite journals via `ws-nanitejournal-read`: one by `id`, or a single
   * nanite's run history by `naniteId` (newest-first), else all journals.
   */
  async naniteJournalRead(input: NaniteJournalReadInput = {}): Promise<NaniteJournal[]> {
    const args: Record<string, unknown> = {};
    if (input.id !== undefined) {
      args.id = input.id;
    }
    if (input.naniteId !== undefined) {
      args.naniteId = input.naniteId;
    }
    if (input.limit !== undefined) {
      args.limit = input.limit;
    }
    const result = await this.callDomainTool('ws-nanitejournal-read', args);
    const parsed = parseToolText(result) as { journals?: unknown } | null;
    const list = Array.isArray(parsed?.journals) ? parsed!.journals : [];
    return list as NaniteJournal[];
  }

  /** Close the client + transport and release the singleton. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.connecting = null;
    // Abort the transport's in-flight streams SYNCHRONOUSLY (transport.close()
    // aborts before its first await) so a control-plane kill that follows can't
    // RST an open SSE/HTTP stream — the source of the unhandled undici
    // "TypeError: terminated". An aborted stream surfaces as an intentional
    // AbortError the SDK does not try to reconnect.
    try {
      void transport?.close();
    } catch {
      // ignore
    }
    await closeQuietly(client, transport);
  }

  /**
   * Return a connected client, establishing the session on first use. `null`
   * when the daemon is unavailable or the handshake fails.
   */
  private async ensureConnected(): Promise<Client | null> {
    if (this.disposed) {
      return null;
    }
    if (this.client) {
      return this.client;
    }
    if (this.connecting) {
      return this.connecting;
    }
    this.connecting = this.connect();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private async connect(): Promise<Client | null> {
    const url = this.resolveUrl();
    if (!url) {
      return null;
    }
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION });
    let transport: StreamableHTTPClientTransport;
    try {
      // Pass a fetch that 405s the standalone GET SSE stream so it never opens —
      // eliminating the undici "TypeError: terminated" unhandled rejection on
      // daemon restart/shutdown. See {@link sseDecliningFetch}.
      transport = new StreamableHTTPClientTransport(new URL(url), { fetch: sseDecliningFetch });
    } catch {
      return null;
    }
    // Route SDK transport/protocol errors to the injected sink. The SDK keeps a
    // standalone GET SSE stream open for notifications; when the daemon dies
    // that stream errors here (SSE disconnect / failed reconnection) rather than
    // through a callTool await. Logging keeps it observable and out of the
    // "unhandled rejection" path.
    transport.onerror = (err) => this.onError(err);
    client.onerror = (err) => this.onError(err);
    try {
      // connect() performs the MCP initialize handshake.
      await client.connect(transport);
    } catch {
      await closeQuietly(client, transport);
      return null;
    }
    if (this.disposed) {
      await closeQuietly(client, transport);
      return null;
    }
    this.client = client;
    this.transport = transport;
    return client;
  }

  /** Drop the current client so the next call reconnects. */
  private resetConnection(): void {
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    void closeQuietly(client, transport);
  }
}

/** Close a client + transport, swallowing any teardown errors. */
async function closeQuietly(
  client: Client | null,
  transport: StreamableHTTPClientTransport | null,
): Promise<void> {
  try {
    await client?.close();
  } catch {
    // ignore
  }
  try {
    await transport?.close();
  } catch {
    // ignore
  }
}
