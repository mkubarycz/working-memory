import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, CallToolResultSchema, ListToolsRequestSchema, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { hostTaskOrigin } from './hostTaskBroker';
import type { NativeInstanceCredentialVault } from './instancePasswordVault';

const requestSchema = z.object({
  requestId: z.string().uuid(), requestSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/), expiresAt: z.number().int(),
});
const issuedSchema = z.object({
  state: z.literal('issued'), token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/), expiresAt: z.number().int(),
});
const tokenSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/), expiresAt: z.number().int() }).strict();
const connectionTools: Tool[] = [
  { name: 'wm-connection-status', description: 'Show this local connector’s approval state and request ID. No document access is available before the instance owner approves in Working Memory Settings > Access.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'wm-request-access', description: 'Request or retry owner-approved read/write access for this local connector. Returns the request ID immediately; never approves itself. Owner approval lasts 90 days. Does not grant owner administration or host-script execution.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];

function result(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function jsonResult(value: unknown): unknown {
  const parsed = z.object({ isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })) }).parse(value);
  if (parsed.isError) throw new Error(parsed.content.find(part => part.text)?.text ?? 'Identity MCP request failed.');
  return JSON.parse(parsed.content.find(part => part.text)?.text ?? '{}');
}

function authenticationFailed(error: unknown): boolean {
  if (error instanceof McpError || error instanceof StreamableHTTPError) return error.code === 401;
  return error instanceof Error && /\bHTTP 401\b|\bauthentication\b|\bUnauthorized\b/i.test(error.message);
}

export class InstanceMcpConnector {
  private readonly origin: string;
  private readonly server = new Server({ name: 'working-memory-local-connector', version: '1.0.0' }, {
    capabilities: { tools: { listChanged: true } },
  });
  private remote: Client | null = null;
  private enrollment: Client | null = null;
  private tools: Tool[] = [];
  private pending: { requestId: string; expiresAt: number } | null = null;
  private error = '';
  private closed = false;
  private connecting: Promise<void> | null = null;
  private readonly abort = new AbortController();

  constructor(private readonly options: {
    mcpUrl: string;
    credentials: Pick<NativeInstanceCredentialVault, 'read' | 'save' | 'forget' | 'available'>;
    pollIntervalMs?: number;
  }) {
    this.origin = hostTaskOrigin(options.mcpUrl);
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...connectionTools, ...this.tools] }));
    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      if (request.params.name === 'wm-connection-status') return result(this.status());
      if (request.params.name === 'wm-request-access') {
        void this.connect();
        return result(this.status());
      }
      if (!this.remote || !this.tools.some(tool => tool.name === request.params.name)) {
        return { isError: true, ...result({ ...this.status(), message: 'Owner approval is required before document access.' }) };
      }
      try { return CallToolResultSchema.parse(await this.remote.callTool(request.params)); }
      catch (error) {
        if (authenticationFailed(error)) {
          const remote = this.remote;
          this.remote = null;
          this.tools = [];
          await remote.close();
          this.error = 'Client access expired or was revoked. Call wm-request-access for a new owner-approved connection.';
          await this.server.sendToolListChanged();
        }
        throw error;
      }
    });
  }

  status() {
    return { instance: this.origin, state: this.remote ? 'connected' : this.pending ? 'awaiting_owner_approval' : this.connecting ? 'connecting' : 'disconnected',
      ...this.pending, ...(this.error ? { error: this.error } : {}),
      message: 'Approve the matching request in Working Memory > Settings > Access. Do not share owner passwords or tokens.' };
  }

  async start(transport: Transport = new StdioServerTransport()): Promise<void> {
    await this.server.connect(transport);
    const onclose = transport.onclose;
    transport.onclose = () => { onclose?.(); void this.close(); };
    void this.connect();
  }

  private async connect(): Promise<void> {
    if (this.closed || this.remote || this.connecting) return this.connecting ?? undefined;
    this.connecting = this.establish().catch(error => {
      if (!this.closed) {
        this.pending = null;
        this.error = error instanceof Error ? error.message : 'Local connector sign-in failed.';
        console.error(`[working-memory-connector] ${this.error}`);
      }
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  private async establish(): Promise<void> {
    this.error = '';
    if (!this.options.credentials.available()) {
      throw new Error('Native secure storage is unavailable. The connector will not save credentials as plaintext. Unlock your OS secure storage, then retry wm-request-access.');
    }
    const saved = await this.options.credentials.read(this.origin);
    const previous = saved ? tokenSchema.parse(JSON.parse(saved)) : null;
    if (previous && previous.expiresAt > Date.now()) {
      try { await this.connectData(previous.token); return; }
      catch (error) {
        if (!authenticationFailed(error)) throw error;
        await this.options.credentials.forget(this.origin);
      }
    }
    const enrollment = new Client({ name: 'working-memory-local-connector', version: '1.0.0' });
    this.enrollment = enrollment;
    try {
      await enrollment.connect(new StreamableHTTPClientTransport(new URL('/identity/v1/mcp', this.origin), {
        ...(previous && previous.expiresAt <= Date.now()
          ? { requestInit: { headers: { Authorization: `Bearer ${previous.token}` } } } : {}),
      }));
      const request = requestSchema.parse(jsonResult(await enrollment.callTool({
        name: 'wm-identity-request-access', arguments: {
          label: 'VS Code Copilot (local connector)', access: 'write',
          refresh: !!previous && previous.expiresAt <= Date.now(),
        },
      })));
      this.pending = { requestId: request.requestId, expiresAt: request.expiresAt };
      console.error(`[working-memory-connector] Approve request ${request.requestId} in Working Memory > Settings > Access.`);
      while (!this.closed && Date.now() < request.expiresAt) {
        const response = jsonResult(await enrollment.callTool({
          name: 'wm-identity-claim-access', arguments: { requestId: request.requestId, requestSecret: request.requestSecret },
        }));
        const issued = issuedSchema.safeParse(response);
        if (issued.success) {
          if (this.closed) return;
          await this.options.credentials.save(this.origin, JSON.stringify({ token: issued.data.token, expiresAt: issued.data.expiresAt }));
          await this.connectData(issued.data.token);
          this.pending = null;
          return;
        }
        if (!z.object({ state: z.literal('pending') }).safeParse(response).success) throw new Error('Unexpected identity response. Request access again.');
        await new Promise<void>(resolve => {
          const onAbort = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { this.abort.signal.removeEventListener('abort', onAbort); resolve(); }, this.options.pollIntervalMs ?? 2000);
          this.abort.signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      if (!this.closed) throw new Error('Approval request expired. Call wm-request-access to try again.');
    } finally {
      await enrollment.close();
      this.enrollment = null;
    }
  }

  private async connectData(token: string): Promise<void> {
    const client = new Client({ name: 'working-memory-local-connector', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(this.options.mcpUrl), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }));
      const tools: Tool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools({ cursor });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      if (this.closed) { await client.close(); return; }
      this.remote = client;
      this.tools = tools;
      await this.server.sendToolListChanged();
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    await Promise.all([this.enrollment?.close(), this.remote?.close()]);
    await this.server.close();
  }
}
