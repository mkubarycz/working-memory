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
