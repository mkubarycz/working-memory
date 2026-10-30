/**
 * The control-plane HTTP surface.
 *
 *   GET  /health          → 200 { ok, version, uptime }
 *   POST /attachments     → store an image in the portable SQLite database
 *   GET  /attachments/:id → stream a stored image
 *   POST|GET|DELETE /mcp  → MCP over Streamable HTTP (stateful sessions)
 *
 * Bound loopback-only by the daemon. Uses the official MCP TypeScript SDK with
 * its Streamable HTTP server transport in **stateful** mode: each client's
 * `initialize` mints a session id (returned in the `mcp-session-id` header) and
 * subsequent requests are routed to that client's transport. This is what lets
 * 3+ independent clients share one authoritative process.
 *
 * Phase 1 registers a single smoke tool, `wm-ping`. The resource layer and the
 * real `wm_*` surface are later phases. The transport's SSE push channel
 * (server-initiated messages / watch-notify) is reserved but unused here.
 */

import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  DEFAULT_PORT,
  HEALTH_PATH,
  HOST,
  MCP_PATH,
  SERVICE_NAME,
  SERVICE_VERSION,
} from './config.js';
import { openStore, type Store, ConflictError, NotFoundError } from './store.js';
import { createDocumentChangeFeed } from './documentChangeFeed.js';
import { HostTaskBroker, HOST_TASK_CLEANUP_INTERVAL_MS, type HostTaskOptions } from './hostTasks.js';
import { AccessError, InstanceAccess, type InstancePrincipal } from './instanceAccess.js';
import { serveInstanceAccessMcp } from './instanceAccessMcp.js';
import { InstanceOAuth } from './instanceOAuth.js';
import { McpSessions, SessionAdmissionError, type SessionDiagnosticsOptions } from './mcpSessions.js';
import { IdentityError } from './instanceIdentity.js';
import { documentPermissionCategory, instancePermissionsSchema, permits } from './instancePermissions.js';
import { authorizeInstanceTool, instanceToolPermissions } from './instanceAuthorization.js';
import type { PermissionSelection } from './instancePermissions.js';
import { registerInstanceTaskTools } from './instanceToolsMcp.js';
import { topicSpecWithDefaults, validateTopicReferences } from './kinds/topic/references.js';
import {
  getKind,
  validateSpec,
  defaultStatus,
  listKinds,
  specFields,
  listKindApis,
} from './kinds/registry.js';

export interface StartServerOptions extends HostTaskOptions {
  sessionDiagnostics?: SessionDiagnosticsOptions;
  host?: string;
  /** TCP port; `0` binds an ephemeral port (used by tests). */
  port?: number;
  version?: string;
  name?: string;
  /**
   * The resource store to back the document tools. When omitted, the server
   * owns an ephemeral `:memory:` store (used by tests) and closes it on
   * `close()`. The daemon injects the durable store, which it owns.
   */
  store?: Store;
}

export interface RunningServer {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Build a fresh MCP server wired to `store`, registering the smoke tool
 * (`wm-ping`) plus the document CRUD surface (`wm-document-create`,
 * `wm-document-read`, `wm-document-update`, `wm-document-delete`). Called once
 * per MCP session; every session shares the one injected store (single-writer,
 * multi-reader).
 */
export function createMcpServer(
  store: Store,
  version: string = SERVICE_VERSION,
  name: string = SERVICE_NAME,
  taskDispatch?: (method: string, path: string, input?: unknown) => unknown,
  canReadKind: (kind: string) => boolean = () => true,
): McpServer {
  const server = new McpServer({ name, version });
  if (taskDispatch) registerInstanceTaskTools(server, taskDispatch);

  const asText = (result: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  });

  const asError = (message: string) => ({
    isError: true,
    content: [{ type: 'text' as const, text: message }],
  });

  server.registerTool('wm-attachment-create', {
    title: 'Working Memory: Upload Image',
    description: 'Store an image attachment (up to 700 KiB via MCP). Provide filename, mimeType and canonical base64 data. Returns an ID and a portable wm-attachment:<id> reference for Markdown. Requires Content Create.',
    inputSchema: {
      filename: z.string().trim().min(1).max(255),
      mimeType: z.string().refine(value => IMAGE_MIME_TYPES.has(value), 'Unsupported image type.'),
      data: z.string().min(4).max(Math.ceil(700 * 1024 / 3) * 4)
        .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    },
  }, async ({ filename, mimeType, data }) => {
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.length || bytes.length > 700 * 1024 || bytes.toString('base64') !== data) {
      return asError('Provide a non-empty image up to 700 KiB encoded as canonical base64.');
    }
    const attachment = store.createAttachment({ filename, mimeType, data: bytes });
    return asText({ id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType,
      size: bytes.length, reference: `wm-attachment:${attachment.id}` });
  });

  server.registerTool(
    'wm-ping',
    {
      title: 'Working Memory: Ping',
      description:
        'Liveness/handshake probe for the Working Memory control-plane. Returns { ok: true, version }.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, version }) }],
    }),
  );

  server.registerTool(
    'wm-document-create',
    {
      title: 'Working Memory: Create Document',
      description:
        'Create a new document (resource) in the Working Memory store. Provide a `kind`, ' +
        'optional `labels`, and an optional `spec` object holding the ' +
        "document body/fields. The `kind` MUST be a registered kind (see `wm-list-kinds`); " +
        'unknown kinds are rejected. The `spec` MUST match the kind\'s schema exactly — ' +
        'required fields must be present and unknown fields are rejected (e.g. "Topic" ' +
        'requires a `title`, ≤120 chars). Resources are identified only by their immutable object IDs. The parsed spec ' +
        '(defaults applied) is what gets ' +
        'persisted. Returns the created document envelope.',
      inputSchema: z.object({
        kind: z.string().describe('The document kind. Must be registered (see wm-list-kinds), e.g. "Topic".'),
        labels: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional string→string labels.'),
        spec: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional desired-state object; must match the kind's spec schema (unknown fields rejected)."),
      }).strict(),
    },
    async ({ kind, labels, spec }) => {
      // The kind MUST be registered — no freeform escape hatch. Rejection lives
      // here (tool/registry layer); the store stays kind-agnostic.
      if (!getKind(kind)) {
        return asError(
          `Unknown kind: "${kind}". Registered kinds: ${listKinds().join(', ') || '(none)'}. ` +
            'Use wm-list-kinds to see allowed kinds and their spec fields.',
        );
      }
      let validatedSpec: Record<string, unknown>;
      let status: Record<string, unknown>;
      try {
        // validateSpec parses (defaults applied, unknown fields rejected via
        // the kind's strict spec). We persist the PARSED value, never the raw
        // input, so a stored document always conforms to its kind.
        validatedSpec = validateSpec(kind, kind === 'Topic' ? topicSpecWithDefaults(store, spec ?? {}) : spec);
        if (kind === 'Topic') validateTopicReferences(store, validatedSpec);
        status = defaultStatus(kind);
      } catch (err) {
        return asError((err as Error).message);
      }
      return asText(store.createDocument({ kind, labels, spec: validatedSpec, status }));
    },
  );

  server.registerTool(
    'wm-document-update',
    {
      title: 'Working Memory: Update Document',
      description:
        'Patch an existing document (a versioned compare-and-swap write). You MUST pass ' +
        '`expectedResourceVersion` — the `resourceVersion` you just read via `wm-document-read`. ' +
        'Provide at least one of `spec` or `labels`. `spec` is a PARTIAL: the fields you ' +
        'pass are shallow-merged onto the current spec, then the MERGED spec is validated against ' +
        "the document's kind schema (unknown fields rejected); the parsed merged spec is what gets " +
        'persisted. `labels` are replace-if-provided — passing `labels` replaces the ' +
        'whole labels object; omitting a field leaves it unchanged. To clear/reset a field send it ' +
        'explicitly (e.g. `spec: { parents: [] }`). If the document changed since you read it ' +
        '(version mismatch), the update is rejected as a conflict and the current version is ' +
        'returned — re-fetch with `wm-document-read`, re-apply, and retry. The controller-owned ' +
        'envelope `status` is not editable here. Returns the updated document envelope (with a ' +
        'bumped `updatedAt` and `resourceVersion`).',
      inputSchema: z.object({
        id: z.string().describe('The id (uuid) of the document to update.'),
        expectedResourceVersion: z
          .number()
          .int()
          .describe('The resourceVersion you read via wm-document-read (CAS guard).'),
        spec: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Partial spec fields to merge onto the current spec; the merged spec must match the ' +
              "kind's schema (unknown fields rejected). Send a field explicitly to clear it (e.g. parents: []).",
          ),
        labels: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional new labels; replaces the whole labels object if provided.'),
      }).strict(),
    },
    async ({ id, expectedResourceVersion, spec, labels }) => {
      // Require at least one editable field so a no-op patch is an explicit error.
      if (spec === undefined && labels === undefined) {
        return asError('Nothing to update: provide at least one of `spec` or `labels`.');
      }
      // Fetch the live doc first: we need its kind + current spec to merge and
      // validate, and to give a clear "unknown id" error before any write work.
      const existing = store.getDocument({ id });
      if (!existing) {
        return asError(`Unknown id: "${id}". No live document with that id (use wm-document-read to confirm).`);
      }
      // The kind must still be registered to validate against — a stored doc
      // whose kind was unregistered can't be safely edited here.
      if (!getKind(existing.kind)) {
        return asError(
          `Cannot update document ${id}: its kind "${existing.kind}" is not registered, so its spec ` +
            'cannot be validated. Register the kind (see wm-list-kinds) first.',
        );
      }
      const newLabels = labels ?? existing.metadata.labels;
      let validatedSpec: Record<string, unknown>;
      try {
        // Shallow-merge the partial patch onto the current spec, then validate
        // the MERGED spec (strict → an unknown field in the patch is rejected).
        // Persist the PARSED merged spec. On validation failure nothing is written.
        const mergedSpec = { ...existing.spec, ...(spec ?? {}) };
        validatedSpec = validateSpec(existing.kind, mergedSpec);
        if (existing.kind === 'Topic') validateTopicReferences(store, validatedSpec);
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        return asText(
          store.updateDocument({
            id,
            expectedResourceVersion,
            spec: validatedSpec,
            labels: newLabels,
          }),
        );
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: document ${id} was expected at resourceVersion ${expectedResourceVersion} ` +
              `but its current resourceVersion is ${err.currentResourceVersion}. Re-fetch it with ` +
              'wm-document-read, re-apply your change to the latest spec, and retry.',
          );
        }
        if (err instanceof NotFoundError) {
          return asError(`Unknown id: "${id}". The document no longer exists (it may have been deleted).`);
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'wm-document-delete',
    {
      title: 'Working Memory: Delete Document',
      description:
        'Soft-delete a document by `id` (stamps `deleted_at`; the row is kept so it can be ' +
        'undeleted). This does NOT validate the spec, so it works on ANY document including legacy / ' +
        'unregistered-kind junk (e.g. old ' +
        'lowercase `topic` docs). After deletion the document drops out of `wm-document-read` ' +
        '(both list and single-read modes). To **undelete** a previously soft-deleted document, call this ' +
        'same tool with `restore: true` (clears `deleted_at`, bumps its version). ' +
        '`expectedResourceVersion` is OPTIONAL and only applies to deletes: when provided it ' +
        'acts as a compare-and-swap guard (the delete is rejected as a conflict if the document ' +
        'changed since you read it); when omitted the current live row is deleted ' +
        'unconditionally. Unknown or already-deleted ids (or already-live ids on restore) are ' +
        'rejected. Returns the affected document envelope.',
      inputSchema: z.object({
        id: z.string().describe('The id (uuid) of the document to delete (or restore).'),
        restore: z
          .boolean()
          .optional()
          .describe('When true, undelete a previously soft-deleted document instead of deleting.'),
        expectedResourceVersion: z
          .number()
          .int()
          .optional()
          .describe('Optional CAS guard for deletes: the resourceVersion you read via wm-document-read.'),
      }).strict(),
    },
    async ({ id, restore, expectedResourceVersion }) => {
      // No spec validation here, so unregistered-kind documents remain manageable.
      try {
        if (restore === true) {
          return asText(store.restoreDocument({ id }));
        }
        return asText(store.deleteDocument({ id, expectedResourceVersion }));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: document ${id} was expected at resourceVersion ${expectedResourceVersion} ` +
              `but its current resourceVersion is ${err.currentResourceVersion}. Re-fetch it with ` +
              'wm-document-read and retry the delete (or omit expectedResourceVersion to force it).',
          );
        }
        if (err instanceof NotFoundError) {
          return asError(
            restore === true
              ? `Unknown or already-live id: "${id}". No soft-deleted document with that id to restore.`
              : `Unknown or already-deleted id: "${id}". No live document with that id ` +
                  '(use wm-document-read to confirm).',
          );
        }
        throw err;
      }
    },
  );

  server.registerTool(
    'wm-list-kinds',
    {
      title: 'Working Memory: List Kinds',
      description:
        'List the registered document kinds (those with a typed descriptor: validated spec, ' +
        'optional status, FTS projection). Only these kinds can be created via ' +
        'wm-document-create; unknown kinds are rejected. Returns { count, kinds } where each ' +
        'entry is { name, specFields } — `specFields` are the allowed top-level `spec` field ' +
        'names (the spec is strict, so anything else is rejected).',
      inputSchema: {},
    },
    async () => {
      const kinds = listKinds().map((name) => ({ name, specFields: specFields(name) }));
      return asText({ count: kinds.length, kinds });
    },
  );

  server.registerTool(
    'wm-document-read',
    {
      title: 'Working Memory: Read Documents',
      description:
        'Read one document or many. Read ONE by passing `id` (optionally scoped by ' +
        '`kind`). Otherwise LIST non-deleted documents newest-first: `kind` filters by kind, and ' +
        '`query` does a BASIC case-insensitive substring match over each document\'s text ' +
        '(ID, labels and spec JSON, i.e. title/body/etc.); `limit` caps how many are returned. This ' +
        '`query` is a simple placeholder text filter, NOT full-text or agentic search. ALWAYS ' +
        'returns { count, documents } \u2014 a by-id read yields a 0-or-1 element list, so ' +
        'callers get one uniform shape.',
      inputSchema: z.object({
        id: z.string().optional().describe('Read a single document by id (uuid).'),
        kind: z.string().optional().describe('Kind filter for an ID lookup or a list, e.g. "Topic".'),
        includeDeleted: z
          .boolean()
          .optional()
          .describe(
            'When true, reads and lists also return soft-deleted documents, including historical Alert aliases of canonical AgentMessages.',
          ),
        query: z
          .string()
          .optional()
          .describe('Basic case-insensitive substring filter over document text (list mode only).'),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max number of documents to return (list mode only).'),
        offset: z.number().int().nonnegative().optional().describe('Number of matching documents to skip (list mode only). Restart paging after document changes.'),
      }).strict(),
    },
    async ({ id, kind, includeDeleted, query, limit, offset = 0 }) => {
      // Single-document read by ID (optionally kind-scoped). Return
      // a 0-or-1 element list so the shape matches the list case exactly.
      if (id !== undefined) {
        const doc = store.getDocument({ id, kind, includeDeleted });
        const documents = doc && canReadKind(doc.kind) ? [doc] : [];
        return asText({ count: documents.length, documents });
      }
      // List mode: non-deleted docs, newest-first, optional kind + query + limit.
      let documents = kind === 'Alert' || kind === 'AgentMessage'
        ? store.listDocumentsByCreation({ kind, includeDeleted }).map(({ document }) => document)
        : store.listDocuments({ kind, includeDeleted });
      documents = documents.filter(doc => canReadKind(doc.kind));
      if (query !== undefined && query.trim() !== '') {
        // Basic placeholder search: case-insensitive substring over the whole
        // envelope's JSON (covers ID, spec title/body, labels). Real FTS is a
        // separate story and deliberately not built here.
        const needle = query.toLowerCase();
        documents = documents.filter((doc) => JSON.stringify(doc).toLowerCase().includes(needle));
      }
      documents = documents.slice(offset, limit === undefined ? undefined : offset + limit);
      return asText({ count: documents.length, documents });
    },
  );

  // Kind plugins: every registered kind may contribute its own namespaced
  // domain API (Workstream → `ws-*`, …). Iterate the kinds that define a
  // `registerApi` hook and wire their tools onto THIS session's server, so each
  // MCP session exposes the generic CRUD PLUS every kind's domain API. The kind
  // registry is populated by `loadKinds()` at daemon startup (or in tests'
  // `beforeAll`) before any session is created.
  for (const { registerApi } of listKindApis()) {
    registerApi(server, store);
  }

  return server;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024 * 1024) throw new Error('JSON request exceeds the 1 MiB limit.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) {
    return undefined;
  }
  return JSON.parse(raw);
}

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

async function readBinaryBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment exceeds the ${MAX_ATTACHMENT_BYTES} byte limit.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function endJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Start the control-plane HTTP server and resolve once it is bound.
 */
export async function startServer(opts: StartServerOptions = {}): Promise<RunningServer> {
  const host = opts.host ?? HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const version = opts.version ?? SERVICE_VERSION;
  const name = opts.name ?? SERVICE_NAME;
  const startedAt = Date.now();

  // The document tools need a store. Callers (the daemon) inject the durable
  // store and own its lifecycle; when absent (tests) we own an ephemeral one.
  const providedStore = opts.store;
  const store = providedStore ?? openStore(':memory:');
  const hostTasks = new HostTaskBroker(store.db, opts);
  const access = new InstanceAccess(store.db, hostTasks.identity, opts.hostTaskClock);
  const sessions = new McpSessions(store.db, opts.sessionDiagnostics);
  let oauth: InstanceOAuth;
  const ownsStore = providedStore === undefined;
  const changeFeed = createDocumentChangeFeed(store);

  // Per-server session registry (stateful Streamable HTTP), keyed by MCP
  // session id. Supports multiple concurrent clients, each with its own MCP
  // session and connected McpServer instance.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function denyPermission(req: http.IncomingMessage, res: http.ServerResponse, required: PermissionSelection[] | null): void {
    try {
      const request = required?.length ? access.requestPermissions(
        req.headers.authorization?.slice(7) ?? '', required, req.socket.remoteAddress ?? 'unknown',
      ) : undefined;
      endJson(res, 403, { error: 'permission_denied', permissionRequest: request,
        message: request?.state === 'pending'
          ? 'Additional access requested. Ask the owner to approve it at the top of Settings > Access, then retry.'
          : request?.state === 'denied'
          ? 'The owner denied this permission request. No access was granted. Do not retry until the owner changes access or the request expires.'
          : 'This client lacks the required permission.' });
    } catch (error) {
      if (!(error instanceof AccessError)) throw error;
      endJson(res, error.status, { error: 'permission_denied', message: error.message });
    }
  }

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, principal: InstancePrincipal): Promise<void> {
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (session && session.principalKey !== principal.key) {
      endJson(res, 403, { error: 'session_identity_mismatch',
        message: 'This MCP session belongs to another credential. Initialize a new session with your own token.' });
      return;
    }

    if (req.method === 'POST') {
      if (session) await sessions.request(session, handlePost);
      else await handlePost();
      return;
    }

    async function handlePost(): Promise<void> {
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        endJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        });
        return;
      }

      if (Array.isArray(body)) {
        endJson(res, 400, { error: 'MCP batch requests are not supported. Send one authenticated request at a time.' });
        return;
      }
      const current = access.authenticate(req.headers.authorization?.slice(7) ?? '');
      if (!current) {
        endJson(res, 401, { error: 'Client access expired or was revoked.' }); return;
      }
      principal = current;
      if (principal.role === 'client' && body && typeof body === 'object' && 'method' in body && body.method === 'tools/call') {
        const call = z.object({ params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }) }).safeParse(body);
        if (!call.success || !authorizeInstanceTool(principal, call.data.params.name, call.data.params.arguments, store)) {
          denyPermission(req, res, call.success ? instanceToolPermissions(call.data.params.name, call.data.params.arguments, store) : null);
          return;
        }
      }
      const existing = sessionId ? transports.get(sessionId) : undefined;
      if (session && existing) {
        await existing.handleRequest(req, res, body);
        return;
      }

      if (!sessionId && isInitializeRequest(body)) {
        let managed;
        try {
          managed = sessions.admit(principal, body.params.clientInfo.name);
        } catch (error) {
          if (!(error instanceof SessionAdmissionError)) throw error;
          res.setHeader('Retry-After', String(error.retryAfter));
          endJson(res, error.status, { jsonrpc: '2.0', error: { code: -32000, message: error.message },
            id: 'id' in body && (typeof body.id === 'number' || typeof body.id === 'string') ? body.id : null });
          return;
        }
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => managed.protocolId,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, transport);
            sessions.initialized(managed);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
          sessions.closed(managed);
        };
        managed.close = () => transport.close();
        try {
          const sessionToken = req.headers.authorization?.slice(7) ?? '';
          const server = createMcpServer(store, version, name, (method, path, input) => {
            const current = access.authenticate(sessionToken);
            if (!current) throw new AccessError(401, 'Client access expired or was revoked.');
            return hostTasks.dispatchInstanceTask(current, method, path, input);
          }, kind => {
            const current = access.authenticate(sessionToken);
            const category = documentPermissionCategory(kind);
            return !!current && (current.role === 'owner' || category !== null && permits(current.permissions, category, 'read'));
          });
          managed.close = async () => {
            transports.delete(managed.protocolId);
            await server.close();
          };
          await sessions.request(managed, async () => {
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
          });
        } catch (error) {
          sessions.failed(managed);
          throw error;
        } finally {
          if (managed.state === 'initializing') sessions.failed(managed);
        }
        return;
      }

      endJson(res, sessionId ? 404 : 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: sessionId ? 'Session not found or expired. Initialize a new session.' : 'Bad Request: no valid session ID' },
        id: null,
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!session || !transport) {
        endJson(res, sessionId ? 404 : 400, { ok: false, error: 'invalid or missing session id' });
        return;
      }
      if (req.method === 'GET') {
        // A notification stream is not an in-flight tool request.
        sessions.touch(session);
        await transport.handleRequest(req, res);
      } else await sessions.request(session, () => transport.handleRequest(req, res));
      return;
    }

    endJson(res, 405, { ok: false, error: 'method not allowed' });
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);
    const token = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '';

    if (oauth.handles(url.pathname)) {
      oauth.handle(req, res);
      return;
    }
    if (url.pathname === '/identity/v1/mcp') {
      if (req.headers.origin || url.search) { endJson(res, 400, { error: 'Use the identity MCP directly, without browser Origin or query credentials.' }); return; }
      if (req.method !== 'POST') { endJson(res, 405, { error: 'Identity MCP accepts POST only.' }); return; }
      await serveInstanceAccessMcp(req, res, access);
      return;
    }
    if (url.pathname === '/identity/v1/setup') {
      const setup = new URL(url);
      setup.pathname = '/host-tasks/v1/admin/identity/setup';
      await hostTasks.handle(req, res, setup);
      return;
    }
    if (url.pathname === '/identity/v1/sessions') {
      try {
        if (req.headers.origin) throw new AccessError(400, 'Use the trusted desktop connection.');
        if (!hostTasks.identity.authenticate(token)) throw new AccessError(401, 'Sign in as the instance owner to view sessions.');
        const query = z.object({ before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional() }).strict()
          .parse(Object.fromEntries(url.searchParams));
        if (req.method === 'POST') {
          if (url.search) throw new AccessError(400, 'Policy updates do not accept query parameters.');
          if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new AccessError(415, 'JSON required.');
          sessions.setPolicy(await readJsonBody(req));
        } else if (req.method !== 'GET') throw new AccessError(405, 'Session management accepts GET or POST.');
        endJson(res, 200, sessions.snapshot(query.before));
      } catch (error) {
        if (error instanceof AccessError) endJson(res, error.status, { error: error.message });
        else if (error instanceof z.ZodError || error instanceof SyntaxError) {
          endJson(res, 400, { error: 'Provide a valid session policy or event cursor. Per-client sessions must not exceed the total limit.' });
        } else throw error;
      }
      return;
    }
    if (url.pathname === '/identity/v1/access') {
      try {
        if (req.headers.origin || url.search) throw new AccessError(400, 'Use the trusted desktop connection without query credentials.');
        if (req.method === 'GET') { endJson(res, 200, access.snapshot(token)); return; }
        if (req.method !== 'POST') throw new AccessError(405, 'Access management accepts GET or POST.');
        if (!hostTasks.identity.authenticate(token)) throw new AccessError(401, 'Sign in as the instance owner to manage access.');
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new AccessError(415, 'JSON required.');
        const action = z.union([
          z.object({ action: z.enum(['approve', 'deny', 'revoke']), id: z.string().uuid() }).strict(),
          z.object({ action: z.literal('permissions'), id: z.string().uuid(), target: z.enum(['request', 'client']), permissions: instancePermissionsSchema }).strict(),
        ]).parse(await readJsonBody(req));
        if (action.action === 'permissions') access.setPermissions(token, action.id, action.target, action.permissions);
        else if (action.action === 'revoke') access.revoke(token, action.id);
        else access.decide(token, action.id, action.action === 'approve');
        endJson(res, 200, access.snapshot(token));
      } catch (error) {
        if (error instanceof AccessError) endJson(res, error.status, { error: error.message });
        else if (error instanceof z.ZodError || error instanceof SyntaxError) endJson(res, 400, { error: 'Provide a valid access action and request or client UUID.' });
        else throw error;
      }
      return;
    }
    if (url.pathname === '/features/v1') {
      const principal = access.authenticate(token);
      if (principal?.role === 'client') {
        if (['GET', 'POST'].includes(req.method ?? '') && !permits(principal.permissions, 'settings', req.method === 'GET' ? 'read' : 'update')) {
          denyPermission(req, res, [{ category: 'settings', operation: req.method === 'GET' ? 'read' : 'update' }]); return;
        }
        await hostTasks.features.handle(req, res, url, () => {
          const current = access.authenticate(token);
          if (!current || !permits(current.permissions, 'settings', req.method === 'GET' ? 'read' : 'update')) {
            throw new IdentityError(403, 'Settings permission required.');
          }
        });
      } else await hostTasks.handleFeatures(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/identity/v1/')) {
      await hostTasks.identity.handle(req, res, url);
      return;
    }
    if (url.pathname === '/host-tasks/v1' || url.pathname.startsWith('/host-tasks/v1/')) {
      await hostTasks.handle(req, res, url);
      return;
    }
    if (hostTasks.isProtectedCredential(req.headers.authorization) && !hostTasks.identity.recognizes(token)) {
      endJson(res, 403, { error: 'host_task_credential_wrong_surface',
        message: 'Host-task credentials cannot access instance data. Request an instance credential through /identity/v1/mcp and ask the owner to approve it in Settings > Access.' });
      return;
    }
    if (req.method === 'GET' && url.pathname === HEALTH_PATH) {
      endJson(res, 200, { ok: true, version, uptime: (Date.now() - startedAt) / 1000 });
      return;
    }
    const principal = access.authenticate(token);
    if (!principal) {
      const identityMcpUrl = new URL('/identity/v1/mcp', url).href;
      res.setHeader('WWW-Authenticate', `Bearer realm="working-memory", resource_metadata="${oauth.origin}/.well-known/oauth-protected-resource/mcp"`);
      endJson(res, 401, { error: 'instance_authentication_required', identityMcpUrl,
        message: 'A valid instance token is required. Desktop users: connect and set an owner password if none exists, or sign in. '
          + `Agents: connect to ${identityMcpUrl}, call wm-identity-request-access, then ask a signed-in owner to approve in Settings > Access. `
          + 'For an expired client token, request refresh with the previous token in the Authorization header. Claim the approved token using wm-identity-claim-access and initialize a new /mcp session.',
        passwordConfigured: hostTasks.identity.configured() });
      return;
    }
    if (req.headers.origin) {
      endJson(res, 400, { error: 'Use a trusted client connection, not a browser Origin.' });
      return;
    }
    if (principal.role === 'client' && url.pathname.startsWith('/attachments')
      && !permits(principal.permissions, 'content', req.method === 'POST' ? 'create' : 'read')) {
      denyPermission(req, res, [{ category: 'content', operation: req.method === 'POST' ? 'create' : 'read' }]);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/changes') {
      if (principal.role === 'client' && (!principal.permissions.content.read || !principal.permissions.settings.read)) {
        denyPermission(req, res, [{ category: 'content', operation: 'read' }, { category: 'settings', operation: 'read' }]); return;
      }
      changeFeed.handle(req, res, url, () => {
        const current = access.authenticate(token);
        return !!current && (current.role === 'owner' || current.permissions.content.read && current.permissions.settings.read);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/attachments') {
      const rawMimeType = Array.isArray(req.headers['content-type'])
        ? req.headers['content-type'][0]
        : req.headers['content-type'];
      const mimeType = rawMimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
      if (!IMAGE_MIME_TYPES.has(mimeType)) {
        endJson(res, 415, { ok: false, error: `Unsupported image type: ${mimeType || '(missing)'}` });
        return;
      }
      const encodedFilename = Array.isArray(req.headers['x-file-name'])
        ? req.headers['x-file-name'][0]
        : req.headers['x-file-name'];
      let filename = 'image';
      if (encodedFilename) {
        try {
          filename = decodeURIComponent(encodedFilename);
        } catch {
          endJson(res, 400, { ok: false, error: 'Invalid x-file-name header.' });
          return;
        }
      }
      const data = await readBinaryBody(req);
      if (data.length === 0) {
        endJson(res, 400, { ok: false, error: 'Attachment body is empty.' });
        return;
      }
      const attachment = store.createAttachment({ mimeType, filename, data });
      endJson(res, 201, {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.data.byteLength,
      });
      return;
    }

    const attachmentMatch = /^\/attachments\/([0-9a-f-]+)$/.exec(url.pathname);
    if (req.method === 'GET' && attachmentMatch) {
      const attachment = store.getAttachment(attachmentMatch[1]);
      if (!attachment) {
        endJson(res, 404, { ok: false, error: 'attachment not found' });
        return;
      }
      res.writeHead(200, {
        'content-type': attachment.mimeType,
        'content-length': attachment.data.byteLength,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(Buffer.from(attachment.data));
      return;
    }

    if (url.pathname === MCP_PATH) {
      await handleMcp(req, res, principal);
      return;
    }

    endJson(res, 404, { ok: false, error: 'not found' });
  }

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res).catch(() => {
      console.error('[control-plane] HTTP request failed.');
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ ok: false, error: 'Request failed. Check the control-plane service logs.' }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    httpServer.once('error', onError);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', onError);
      resolve();
    });
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  oauth = new InstanceOAuth(store.db, access, `http://127.0.0.1:${boundPort}`, opts.hostTaskClock);
  const hostTaskCleanupTimer = setInterval(() => {
    try { hostTasks.cleanup(); }
    catch { console.error('[host-tasks] Retention cleanup failed.'); }
  }, HOST_TASK_CLEANUP_INTERVAL_MS);
  hostTaskCleanupTimer.unref();
  const sessionCleanupTimer = setInterval(() => {
    try { sessions.sweep(); }
    catch (error) { console.error('[mcp-sessions] Retention cleanup failed:', error); }
  }, 60000);
  sessionCleanupTimer.unref();

  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    async close(): Promise<void> {
      clearInterval(hostTaskCleanupTimer);
      clearInterval(sessionCleanupTimer);
      changeFeed.close();
      await sessions.close();
      transports.clear();
      return new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          // Only close a store we own; an injected store is the caller's to close.
          if (ownsStore) {
            try {
              store.close();
            } catch {
              /* ignore */
            }
          }
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
        // Force-drop lingering keep-alive/SSE sockets so close() resolves promptly.
        (httpServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      });
    },
  };
}
