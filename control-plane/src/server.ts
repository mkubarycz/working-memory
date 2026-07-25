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
 * Phase 1 registers a single smoke tool, `wm_ping`. The resource layer and the
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
 * (`wm_ping`) plus the document CRUD surface (`wm_create_document`,
 * `wm_list_documents`, `wm_get_document`). Called once per MCP session; every
 * session shares the one injected store (single-writer, multi-reader).
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
    'wm_ping',
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
    'wm_create_document',
    {
      title: 'Working Memory: Create Document',
      description:
        'Create a new document (resource) in the Working Memory store. Provide a `kind`, ' +
        'an optional `slug`, optional `labels`, and an optional `spec` object holding the ' +
        "document body/fields. The `kind` MUST be a registered kind (see `wm_list_kinds`); " +
        'unknown kinds are rejected. The `spec` MUST match the kind\'s schema exactly — ' +
        'required fields must be present and unknown fields are rejected (e.g. "Topic" ' +
        'requires a `title`, ≤120 chars). The parsed spec (defaults applied) is what gets ' +
        'persisted. Returns the created document envelope.',
      inputSchema: {
        kind: z.string().describe('The document kind. Must be registered (see wm_list_kinds), e.g. "Topic".'),
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
            'Use wm_list_kinds to see allowed kinds and their spec fields.',
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
    'wm_update_document',
    {
      title: 'Working Memory: Update Document',
      description:
        'Edit an existing document by replacing its `spec` (a versioned compare-and-swap write). ' +
        'You MUST pass `expectedResourceVersion` — the `resourceVersion` you just read via ' +
        '`wm_get_document`. The full `spec` you provide REPLACES the current spec and MUST match ' +
        "the document's kind schema exactly (required fields present, unknown fields rejected); " +
        'the parsed spec (defaults applied) is what gets persisted. If the document has changed ' +
        'since you read it (version mismatch), the update is rejected as a conflict and the ' +
        'current version is returned — re-fetch with `wm_get_document`, re-apply your change, and ' +
        'retry. The controller-owned envelope `status`, slug, and labels are not editable here. ' +
        'Returns the updated document envelope (with a bumped `updatedAt` and `resourceVersion`).',
      inputSchema: {
        id: z.string().describe('The id (uuid) of the document to update.'),
        expectedResourceVersion: z
          .number()
          .int()
          .describe('The resourceVersion you read via wm_get_document (CAS guard).'),
        spec: z
          .record(z.string(), z.unknown())
          .describe("The full replacement spec; must match the kind's schema (unknown fields rejected)."),
      },
    },
    async ({ id, expectedResourceVersion, spec }) => {
      // Fetch the live doc first: we need its kind to validate, and to give a
      // clear "unknown id" error before doing any write work.
      const existing = store.getDocument({ id });
      if (!existing) {
        return asError(`Unknown id: "${id}". No live document with that id (use wm_get_document to confirm).`);
      }
      // The kind must still be registered to validate against — a stored doc
      // whose kind was unregistered can't be safely edited here.
      if (!getKind(existing.kind)) {
        return asError(
          `Cannot update document ${id}: its kind "${existing.kind}" is not registered, so its spec ` +
            'cannot be validated. Register the kind (see wm_list_kinds) first.',
        );
      }
      let validatedSpec: Record<string, unknown>;
      try {
        // Persist the PARSED spec (defaults applied, unknown fields rejected).
        // On validation failure nothing is written.
        validatedSpec = validateSpec(existing.kind, spec);
      } catch (err) {
        return asError((err as Error).message);
      }
      try {
        return asText(store.updateDocument({ id, expectedResourceVersion, spec: validatedSpec }));
      } catch (err) {
        if (err instanceof ConflictError) {
          return asError(
            `Conflict: document ${id} was expected at resourceVersion ${expectedResourceVersion} ` +
              `but its current resourceVersion is ${err.currentResourceVersion}. Re-fetch it with ` +
              'wm_get_document, re-apply your change to the latest spec, and retry.',
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
    'wm_list_kinds',
    {
      title: 'Working Memory: List Kinds',
      description:
        'List the registered document kinds (those with a typed descriptor: validated spec, ' +
        'optional status, FTS projection). Only these kinds can be created via ' +
        'wm_create_document; unknown kinds are rejected. Returns { count, kinds } where each ' +
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
    'wm_list_documents',
    {
      title: 'Working Memory: List Documents',
      description:
        'List all documents (resources) in the Working Memory store, optionally filtered by kind. ' +
        'Returns { count, documents } with the newest documents first.',
      inputSchema: {
        kind: z.string().optional().describe('Optional kind filter, e.g. "topic".'),
      },
    },
    async ({ kind }) => {
      const documents = store.listDocuments({ kind });
      return asText({ count: documents.length, documents });
    },
  );

  server.registerTool(
    'wm_get_document',
    {
      title: 'Working Memory: Get Document',
      description:
        'Fetch a single document (resource) by `id`, or by `slug` (optionally scoped by `kind`). ' +
        'Returns the document envelope, or { found: false } when nothing matches.',
      inputSchema: {
        id: z.string().optional().describe('The document id (uuid).'),
        slug: z.string().optional().describe('The document slug.'),
        kind: z.string().optional().describe('Optional kind to scope a slug lookup.'),
      },
    },
    async ({ id, slug, kind }) => {
      const doc = store.getDocument({ id, slug, kind });
      return asText(doc ?? { found: false });
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
