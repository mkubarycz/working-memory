import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  AppMcpEndpoint,
  AppMcpStatus,
  AppMcpTool,
  AppMcpToolListing,
  AppResourceContract,
  ContainerAppId,
} from '../shared/contracts';

interface Connection {
  client: AppMcpClient;
  endpoint: AppMcpEndpoint;
  connectionId: number;
}

export function parseAppResourceContract(result: unknown): AppResourceContract {
  const content = isRecord(result) && Array.isArray(result.content) ? result.content : [];
  const text = content.find((item) => isRecord(item) && item.type === 'text' && typeof item.text === 'string');
  let value: unknown;
  try {
    value = text && isRecord(text) ? JSON.parse(String(text.text)) : result;
  } catch {
    throw new Error('The application contract discovery tool returned invalid JSON.');
  }
  if (
    !isRecord(value)
    || typeof value.contractVersion !== 'string'
    || !isRecord(value.application)
    || (!isRecord(value.resources) && !Array.isArray(value.resources))
  ) {
    throw new Error('The application contract discovery tool returned an invalid resource contract.');
  }
  const application = value.application;
  if (
    typeof application.id !== 'string'
    || (
      typeof application.name !== 'string'
      && typeof application.title !== 'string'
    )
  ) {
    throw new Error('The application contract has invalid application metadata.');
  }
  if (!isRecord(value.envelope)) {
    throw new Error('The application contract is missing the common resource envelope.');
  }
  const envelopeFields = Array.isArray(value.envelope.fields)
    ? value.envelope.fields
    : Object.keys(value.envelope);
  for (const key of ['kind', 'metadata', 'spec', 'status', 'relationships']) {
    if (!envelopeFields.includes(key)) throw new Error(`The application contract envelope is missing "${key}".`);
  }
  return value as unknown as AppResourceContract;
}

type AppMcpClient = Pick<Client, 'connect' | 'close' | 'listTools' | 'callTool'>;

export interface AppMcpServiceOptions {
  timeoutMs?: number;
  createClient?: (appId: ContainerAppId) => AppMcpClient;
  createTransport?: (endpoint: AppMcpEndpoint) => Transport;
}

export class AppMcpService {
  private readonly connections = new Map<ContainerAppId, Connection>();
  private readonly inFlight = new Map<ContainerAppId, { client: AppMcpClient; token: number }>();
  private readonly errors = new Map<ContainerAppId, string>();
  private readonly generations = new Map<ContainerAppId, number>();
  private epoch = 0;
  private nextConnectionId = 1;
  private readonly timeoutMs: number;
  private readonly createClient: NonNullable<AppMcpServiceOptions['createClient']>;
  private readonly createTransport: NonNullable<AppMcpServiceOptions['createTransport']>;

  constructor(options: AppMcpServiceOptions | number = {}) {
    const resolved = typeof options === 'number' ? { timeoutMs: options } : options;
    this.timeoutMs = resolved.timeoutMs ?? 10_000;
    this.createClient = resolved.createClient
      ?? ((appId) => new Client({ name: `working-memory-desktop-${appId}`, version: '1.0.0' }));
    this.createTransport = resolved.createTransport
      ?? ((endpoint) => new StreamableHTTPClientTransport(new URL(endpoint.url), {
        fetch: noRedirectFetch,
      }));
  }

  status(appId: ContainerAppId, endpoint?: AppMcpEndpoint): AppMcpStatus {
    const connection = this.connections.get(appId);
    const normalizedEndpoint = endpoint ? normalizeAppMcpEndpoint(endpoint) : undefined;
    const matches = Boolean(
      connection
      && normalizedEndpoint
      && sameEndpoint(connection.endpoint, normalizedEndpoint),
    );
    return {
      appId,
      ...(normalizedEndpoint ? { endpoint: normalizedEndpoint } : {}),
      ...(matches ? { connectionId: connection!.connectionId } : {}),
      state: !endpoint
        ? 'unavailable'
        : matches ? 'connected' : this.errors.has(appId) ? 'error' : 'disconnected',
      error: this.errors.get(appId) ?? null,
    };
  }

  async connect(appId: ContainerAppId, endpoint: AppMcpEndpoint): Promise<AppMcpStatus> {
    const normalizedEndpoint = normalizeAppMcpEndpoint(endpoint);
    const current = this.connections.get(appId);
    if (current && sameEndpoint(current.endpoint, normalizedEndpoint)) {
      return this.status(appId, normalizedEndpoint);
    }
    const epoch = this.epoch;
    await this.disconnect(appId);
    if (this.epoch !== epoch) throw new Error(`Connection to ${normalizedEndpoint.url} was cancelled.`);
    const token = this.generation(appId);
    const client = this.createClient(appId);
    this.inFlight.set(appId, { client, token });
    try {
      await client.connect(this.createTransport(normalizedEndpoint), {
        timeout: this.timeoutMs,
      });
      if (
        this.epoch !== epoch
        || this.generation(appId) !== token
        || this.inFlight.get(appId)?.client !== client
      ) {
        await client.close().catch(() => undefined);
        throw new Error(`Connection to ${normalizedEndpoint.url} was cancelled.`);
      }
      this.inFlight.delete(appId);
      this.connections.set(appId, {
        client,
        endpoint: normalizedEndpoint,
        connectionId: this.nextConnectionId++,
      });
      this.errors.delete(appId);
      return this.status(appId, normalizedEndpoint);
    } catch (error) {
      if (this.inFlight.get(appId)?.client === client) this.inFlight.delete(appId);
      await client.close().catch(() => undefined);
      const message = `Unable to connect to ${normalizedEndpoint.url}: ${errorMessage(error)}`;
      if (this.generation(appId) === token) this.errors.set(appId, message);
      throw new Error(message);
    }
  }

  async disconnect(appId: ContainerAppId): Promise<AppMcpStatus> {
    this.generations.set(appId, this.generation(appId) + 1);
    const connection = this.connections.get(appId);
    const pending = this.inFlight.get(appId);
    this.connections.delete(appId);
    this.inFlight.delete(appId);
    this.errors.delete(appId);
    const clients = [...new Set([connection?.client, pending?.client].filter(Boolean))] as AppMcpClient[];
    const outcomes = await Promise.allSettled(clients.map((client) => client.close()));
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
    return this.status(appId, connection?.endpoint);
  }

  async disconnectAll(): Promise<void> {
    this.epoch += 1;
    const ids = [...new Set([...this.connections.keys(), ...this.inFlight.keys()])];
    const outcomes = await Promise.allSettled(ids.map((id) => this.disconnect(id)));
    const rejected = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');
    if (rejected) throw rejected.reason;
  }

  async listTools(appId: ContainerAppId): Promise<AppMcpTool[]> {
    return (await this.listToolsForRoute(appId)).tools;
  }

  async listToolsForRoute(
    appId: ContainerAppId,
    endpoint?: AppMcpEndpoint,
  ): Promise<AppMcpToolListing> {
    const expected = endpoint ? { endpoint: normalizeAppMcpEndpoint(endpoint) } : undefined;
    const connection = this.requireConnection(appId, expected);
    const result = await connection.client.listTools({}, { timeout: this.timeoutMs });
    if (this.connections.get(appId) !== connection) {
      throw new Error(`The @${appId} MCP connection changed while tools were being listed.`);
    }
    return {
      connectionId: connection.connectionId,
      endpoint: connection.endpoint,
      tools: result.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema as Record<string, unknown>,
      ...(tool.annotations ? { annotations: {
        ...(typeof tool.annotations.readOnlyHint === 'boolean' ? { readOnlyHint: tool.annotations.readOnlyHint } : {}),
        ...(typeof tool.annotations.destructiveHint === 'boolean' ? { destructiveHint: tool.annotations.destructiveHint } : {}),
        ...(typeof tool.annotations.idempotentHint === 'boolean' ? { idempotentHint: tool.annotations.idempotentHint } : {}),
        ...(typeof tool.annotations.openWorldHint === 'boolean' ? { openWorldHint: tool.annotations.openWorldHint } : {}),
      } } : {}),
      })),
    };
  }

  async callTool(
    appId: ContainerAppId,
    name: string,
    args: Record<string, unknown>,
    expected?: { connectionId: number; endpoint: AppMcpEndpoint },
  ): Promise<unknown> {
    if (!name.trim()) throw new Error('A tool name is required.');
    if (!args || Array.isArray(args) || typeof args !== 'object') {
      throw new Error('Tool arguments must be a JSON object.');
    }
    const connection = this.requireConnection(appId, expected);
    return connection.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: this.timeoutMs },
    );
  }

  private requireConnection(
    appId: ContainerAppId,
    expected?: { connectionId?: number; endpoint: AppMcpEndpoint },
  ): Connection {
    const connection = this.connections.get(appId);
    if (!connection) throw new Error(`The ${appId} MCP endpoint is not connected.`);
    if (
      expected
      && (
        (expected.connectionId !== undefined && connection.connectionId !== expected.connectionId)
        || !sameEndpoint(connection.endpoint, normalizeAppMcpEndpoint(expected.endpoint))
      )
    ) {
      throw new Error(`The @${appId} MCP connection changed after its tools were listed. Retry the chat request.`);
    }
    return connection;
  }

  private generation(appId: ContainerAppId): number {
    return this.generations.get(appId) ?? 0;
  }
}

export async function noRedirectFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, redirect: 'manual' });
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    throw new Error(
      `App MCP endpoint returned HTTP ${response.status} redirect`
      + `${location ? ` to "${location}"` : ''}; redirects are not allowed.`,
    );
  }
  return response;
}

export function validateAppMcpEndpoint(endpoint: AppMcpEndpoint): URL {
  if (endpoint.transport !== 'streamable-http') throw new Error('Unsupported MCP transport.');
  if (!/^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]+)?(?:\/|$)/i.test(endpoint.url)) {
    throw new Error('App MCP endpoints must use HTTP on localhost or 127.0.0.1.');
  }
  const url = new URL(endpoint.url);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('App MCP endpoints must use HTTP on localhost or 127.0.0.1.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('App MCP endpoint credentials, query strings, and fragments are not allowed.');
  }
  return url;
}

export function normalizeAppMcpEndpoint(endpoint: AppMcpEndpoint): AppMcpEndpoint {
  const url = validateAppMcpEndpoint(endpoint);
  return Object.freeze({ transport: 'streamable-http', url: url.href });
}

function sameEndpoint(left: AppMcpEndpoint, right: AppMcpEndpoint): boolean {
  return left.transport === right.transport && left.url === right.url;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
