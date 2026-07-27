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

export interface ControlPlaneClientOptions {
  /**
   * Resolve the `/mcp` URL to connect to, or `null` when the daemon is
   * unavailable. Defaults to reading the discovery port file. Tests inject a
   * fixed URL pointing at an ephemeral in-process server.
   */
  resolveUrl?: () => string | null;
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
function defaultResolveUrl(): string | null {
  const home = resolveControlPlaneHome({
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
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
 * Lazy-singleton MCP client for the control-plane. Connects on first use and
 * reuses the session across calls; a failed call drops the client so the next
 * one reconnects (handling daemon restarts / dropped connections).
 */
export class ControlPlaneClient {
  private readonly resolveUrl: () => string | null;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  /** In-flight connect, so concurrent calls share one handshake. */
  private connecting: Promise<Client | null> | null = null;
  private disposed = false;

  constructor(options: ControlPlaneClientOptions = {}) {
    this.resolveUrl = options.resolveUrl ?? defaultResolveUrl;
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

  /** Close the client + transport and release the singleton. */
  async dispose(): Promise<void> {
    this.disposed = true;
    const client = this.client;
    const transport = this.transport;
    this.client = null;
    this.transport = null;
    this.connecting = null;
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
      transport = new StreamableHTTPClientTransport(new URL(url));
    } catch {
      return null;
    }
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
