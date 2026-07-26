/**
 * The control-plane HTTP surface.
 *
 *   GET  /health          → 200 { ok, version, uptime }
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
import { getKind, validateSpec, defaultStatus, listKinds, specFields } from './kinds/registry.js';

export interface StartServerOptions {
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
): McpServer {
  const server = new McpServer({ name, version });

  const asText = (result: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  });

  const asError = (message: string) => ({
    isError: true,
    content: [{ type: 'text' as const, text: message }],
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
        'an optional `slug`, optional `labels`, and an optional `spec` object holding the ' +
        "document body/fields. The `kind` MUST be a registered kind (see `wm-list-kinds`); " +
        'unknown kinds are rejected. The `spec` MUST match the kind\'s schema exactly — ' +
        'required fields must be present and unknown fields are rejected (e.g. "Topic" ' +
        'requires a `title`, ≤120 chars). The parsed spec (defaults applied) is what gets ' +
        'persisted. Returns the created document envelope.',
      inputSchema: {
        kind: z.string().describe('The document kind. Must be registered (see wm-list-kinds), e.g. "Topic".'),
        slug: z.string().optional().describe('Optional human-friendly slug.'),
        labels: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional string→string labels.'),
        spec: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Optional desired-state object; must match the kind's spec schema (unknown fields rejected)."),
      },
    },
    async ({ kind, slug, labels, spec }) => {
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
        validatedSpec = validateSpec(kind, spec);
        status = defaultStatus(kind);
      } catch (err) {
        return asError((err as Error).message);
      }
      return asText(store.createDocument({ kind, slug, labels, spec: validatedSpec, status }));
    },
  );

  server.registerTool(
    'wm-document-update',
    {
      title: 'Working Memory: Update Document',
      description:
        'Patch an existing document (a versioned compare-and-swap write). You MUST pass ' +
        '`expectedResourceVersion` — the `resourceVersion` you just read via `wm-document-read`. ' +
        'Provide at least one of `spec`, `slug`, or `labels`. `spec` is a PARTIAL: the fields you ' +
        'pass are shallow-merged onto the current spec, then the MERGED spec is validated against ' +
        "the document's kind schema (unknown fields rejected); the parsed merged spec is what gets " +
        'persisted. `slug` and `labels` are replace-if-provided — passing `labels` replaces the ' +
        'whole labels object; omitting a field leaves it unchanged. To clear/reset a field send it ' +
        'explicitly (e.g. `spec: { parents: [] }`). If the document changed since you read it ' +
        '(version mismatch), the update is rejected as a conflict and the current version is ' +
        'returned — re-fetch with `wm-document-read`, re-apply, and retry. The controller-owned ' +
        'envelope `status` is not editable here. Returns the updated document envelope (with a ' +
        'bumped `updatedAt` and `resourceVersion`).',
      inputSchema: {
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
        slug: z.string().optional().describe('Optional new slug (replaces if provided).'),
        labels: z
          .record(z.string(), z.string())
          .optional()
          .describe('Optional new labels; replaces the whole labels object if provided.'),
      },
    },
    async ({ id, expectedResourceVersion, spec, slug, labels }) => {
      // Require at least one editable field so a no-op patch is an explicit error.
      if (spec === undefined && slug === undefined && labels === undefined) {
        return asError('Nothing to update: provide at least one of `spec`, `slug`, or `labels`.');
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
      let validatedSpec: Record<string, unknown>;
      try {
        // Shallow-merge the partial patch onto the current spec, then validate
        // the MERGED spec (strict → an unknown field in the patch is rejected).
        // Persist the PARSED merged spec. On validation failure nothing is written.
        const mergedSpec = { ...existing.spec, ...(spec ?? {}) };
        validatedSpec = validateSpec(existing.kind, mergedSpec);
      } catch (err) {
        return asError((err as Error).message);
      }
      // slug / labels are replace-if-provided: fall back to current when omitted.
      const newSlug = slug ?? existing.metadata.slug;
      const newLabels = labels ?? existing.metadata.labels;
      try {
        return asText(
          store.updateDocument({
            id,
            expectedResourceVersion,
            spec: validatedSpec,
            slug: newSlug,
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
        'undeleted). This is **kind-agnostic** — it does NOT look up the kind or validate the ' +
        'spec, so it works on ANY document including legacy / unregistered-kind junk (e.g. old ' +
        'lowercase `topic` docs). After deletion the document drops out of `wm-document-read` ' +
        '(both list and single-read modes). To **undelete** a previously soft-deleted document, call this ' +
        'same tool with `restore: true` (clears `deleted_at`, bumps its version). ' +
        '`expectedResourceVersion` is OPTIONAL and only applies to deletes: when provided it ' +
        'acts as a compare-and-swap guard (the delete is rejected as a conflict if the document ' +
        'changed since you read it); when omitted the current live row is deleted ' +
        'unconditionally. Unknown or already-deleted ids (or already-live ids on restore) are ' +
        'rejected. Returns the affected document envelope.',
      inputSchema: {
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
      },
    },
    async ({ id, restore, expectedResourceVersion }) => {
      // No kind lookup / spec validation here — delete/restore is deliberately
      // kind-agnostic so unregistered-kind documents remain manageable.
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
        'Read one document or many. Read ONE by passing `id`, or by `slug` (optionally scoped by ' +
        '`kind`). Otherwise LIST non-deleted documents newest-first: `kind` filters by kind, and ' +
        '`query` does a BASIC case-insensitive substring match over each document\'s text ' +
        '(slug + spec JSON, i.e. title/body/etc.); `limit` caps how many are returned. This ' +
        '`query` is a simple placeholder text filter, NOT full-text or agentic search. ALWAYS ' +
        'returns { count, documents } \u2014 a by-id/slug read yields a 0-or-1 element list, so ' +
        'callers get one uniform shape.',
      inputSchema: {
        id: z.string().optional().describe('Read a single document by id (uuid).'),
        slug: z
          .string()
          .optional()
          .describe('Read a single document by slug (optionally scoped by kind).'),
        kind: z.string().optional().describe('Kind filter for a slug lookup or a list, e.g. "Topic".'),
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
      },
    },
    async ({ id, slug, kind, query, limit }) => {
      // Single-document read: by id, or by slug (optionally kind-scoped). Return
      // a 0-or-1 element list so the shape matches the list case exactly.
      if (id !== undefined || slug !== undefined) {
        const doc = store.getDocument({ id, slug, kind });
        const documents = doc ? [doc] : [];
        return asText({ count: documents.length, documents });
      }
      // List mode: non-deleted docs, newest-first, optional kind + query + limit.
      let documents = store.listDocuments({ kind });
      if (query !== undefined && query.trim() !== '') {
        // Basic placeholder search: case-insensitive substring over the whole
        // envelope's JSON (covers slug, spec title/body, labels). Real FTS is a
        // separate story and deliberately not built here.
        const needle = query.toLowerCase();
        documents = documents.filter((doc) => JSON.stringify(doc).toLowerCase().includes(needle));
      }
      if (limit !== undefined) {
        documents = documents.slice(0, limit);
      }
      return asText({ count: documents.length, documents });
    },
  );

  return server;
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
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
  const ownsStore = providedStore === undefined;

  // Per-server session registry (stateful Streamable HTTP), keyed by MCP
  // session id. Supports multiple concurrent clients, each with its own MCP
  // session and connected McpServer instance.
  const transports = new Map<string, StreamableHTTPServerTransport>();

  async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;

    if (req.method === 'POST') {
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

      const existing = sessionId ? transports.get(sessionId) : undefined;
      if (existing) {
        await existing.handleRequest(req, res, body);
        return;
      }

      if (!sessionId && isInitializeRequest(body)) {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) {
            transports.delete(transport.sessionId);
          }
        };
        const server = createMcpServer(store, version, name);
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      endJson(res, 400, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session ID' },
        id: null,
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        endJson(res, 400, { ok: false, error: 'invalid or missing session id' });
        return;
      }
      await transport.handleRequest(req, res);
      return;
    }

    endJson(res, 405, { ok: false, error: 'method not allowed' });
  }

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `${host}:${port}`}`);

    if (req.method === 'GET' && url.pathname === HEALTH_PATH) {
      endJson(res, 200, { ok: true, version, uptime: (Date.now() - startedAt) / 1000 });
      return;
    }

    if (url.pathname === MCP_PATH) {
      await handleMcp(req, res);
      return;
    }

    endJson(res, 404, { ok: false, error: 'not found' });
  }

  const httpServer = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
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

  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}`,
    close(): Promise<void> {
      for (const transport of transports.values()) {
        void Promise.resolve(transport.close()).catch(() => undefined);
      }
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
