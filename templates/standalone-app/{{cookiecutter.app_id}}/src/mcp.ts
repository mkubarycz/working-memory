import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { appConfig } from './app/config.js';
import { applicationContract } from './contract.js';
import type { ResourceRegistry } from './framework/registry.js';
import type { ResourceService } from './framework/service.js';

const contextSchema = {
  transactionId: z.string().uuid().optional(),
  actor: z.string().trim().min(1).max(200).optional(),
};

export class McpAdapter {
  readonly #transports = new Map<string, StreamableHTTPServerTransport>();

  constructor(
    readonly registry: ResourceRegistry,
    readonly service: ResourceService,
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse, body?: unknown): Promise<void> {
    const sessionId = String(req.headers['mcp-session-id'] ?? '');
    if (req.method === 'POST') {
      const existing = this.#transports.get(sessionId);
      if (existing) return existing.handleRequest(req, res, body);
      if (!sessionId && isInitialize(body)) {
        let transport: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id): void => {
            this.#transports.set(id, transport);
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) this.#transports.delete(transport.sessionId);
        };
        await this.createServer().connect(transport);
        return transport.handleRequest(req, res, body);
      }
    } else if (req.method === 'GET' || req.method === 'DELETE') {
      const existing = this.#transports.get(sessionId);
      if (existing) return existing.handleRequest(req, res);
    }
    json(res, 400, { error: 'Invalid or missing MCP session.' });
  }

  private createServer(): McpServer {
    const server = new McpServer({ name: appConfig.id, version: appConfig.version });
    server.registerTool('contract-discover', {
      title: 'Discover application contract',
      description: 'Return the live Zod-derived resource contract. Call this before resource operations.',
      inputSchema: { transactionId: z.string().uuid().optional() },
      annotations: { readOnlyHint: true },
    }, async ({ transactionId }) => text({
      transactionId: transactionId ?? crypto.randomUUID(),
      result: applicationContract(this.registry),
    }));
    server.registerTool('resource-query', {
      description: 'Query envelopes of one discovered resource kind using optional top-level spec equality.',
      inputSchema: {
        kind: z.string().min(1),
        specEquals: z.record(z.string(), z.unknown()).optional(),
        transactionId: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: true },
    }, async (input) => text(this.service.query(input.kind, input.specEquals, input.transactionId)));
    server.registerTool('resource-get', {
      description: 'Get one resource envelope by discovered kind and identifier.',
      inputSchema: {
        kind: z.string().min(1),
        id: z.string().uuid(),
        transactionId: z.string().uuid().optional(),
      },
      annotations: { readOnlyHint: true },
    }, async (input) => text(this.service.get(input.kind, input.id, input.transactionId)));
    server.registerTool('resource-create', {
      description: 'Create a validated resource envelope.',
      inputSchema: {
        kind: z.string().min(1),
        spec: z.record(z.string(), z.unknown()),
        status: z.record(z.string(), z.unknown()).optional(),
        relationships: z.record(z.string(), z.unknown()).optional(),
        ...contextSchema,
      },
    }, async (input) => text(this.service.create(input)));
    server.registerTool('resource-update', {
      description: 'Replace a resource envelope using resource-version compare-and-swap.',
      inputSchema: {
        kind: z.string().min(1),
        id: z.string().uuid(),
        expectedResourceVersion: z.number().int().positive(),
        spec: z.record(z.string(), z.unknown()),
        status: z.record(z.string(), z.unknown()),
        relationships: z.record(z.string(), z.unknown()),
        ...contextSchema,
      },
    }, async (input) => text(this.service.update(input)));
    server.registerTool('resource-delete', {
      description: 'Delete a resource envelope using resource-version compare-and-swap.',
      inputSchema: {
        kind: z.string().min(1),
        id: z.string().uuid(),
        expectedResourceVersion: z.number().int().positive(),
        ...contextSchema,
      },
    }, async (input) => text(this.service.delete(input)));
    return server;
  }
}

function isInitialize(value: unknown): boolean {
  return Boolean(value && typeof value === 'object' && 'method' in value && value.method === 'initialize');
}

function text(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}
