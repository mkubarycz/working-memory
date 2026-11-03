import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { describe, expect, it, vi } from 'vitest';
import {
  AppMcpService,
  parseAppResourceContract,
  validateAppMcpEndpoint,
} from '../src/main/appMcpService';

describe('app MCP endpoint security and lifecycle', () => {
  it.each(['connect', 'list', 'call'])('cancels the underlying SDK %s without disconnecting an existing shared connection', async stage => {
    let started = false;
    const hold = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      if (!signal) throw new Error('SDK request is missing its cancellation signal');
      started = true;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    const client = {
      connect: vi.fn<Client['connect']>().mockImplementation(async (_transport, options) => {
        if (stage === 'connect') await hold(options?.signal);
      }),
      close: vi.fn<Client['close']>().mockResolvedValue(undefined),
      listTools: vi.fn<Client['listTools']>().mockImplementation(async (_params, options) => {
        if (stage === 'list') await hold(options?.signal);
        return { tools: [] };
      }),
      callTool: vi.fn<Client['callTool']>().mockImplementation(async (_params, _schema, options) => {
        if (stage === 'call') await hold(options?.signal);
        return { content: [] };
      }),
    };
    const service = new AppMcpService({ createClient: () => client, createTransport: () => ({} as Transport) });
    const endpoint = { transport: 'streamable-http' as const, url: 'http://localhost:4175/mcp' };
    const controller = new AbortController();
    if (stage !== 'connect') await service.connect('queries', endpoint);
    const pending = stage === 'connect' ? service.connect('queries', endpoint, controller.signal)
      : stage === 'list' ? service.listToolsForRoute('queries', endpoint, controller.signal)
        : service.callTool('queries', 'read', {}, undefined, controller.signal);
    await vi.waitFor(() => expect(started).toBe(true));
    controller.abort(new Error('Search cancelled'));
    await expect(pending).rejects.toThrow('Search cancelled');
    if (stage !== 'connect') {
      expect(service.status('queries', endpoint).state).toBe('connected');
      expect(client.close).not.toHaveBeenCalled();
    }
    await service.disconnectAll();
  });

  it('validates live resource contracts returned as MCP text', () => {
    const contract = parseAppResourceContract({
      content: [{ type: 'text', text: JSON.stringify({
        contractVersion: '1.0',
        application: {
          id: 'tasks',
          name: 'Tasks',
          version: '1.0.0',
        },
        envelope: {
          fields: ['kind', 'metadata', 'spec', 'status', 'relationships'],
          jsonSchema: {},
        },
        resources: { Task: { schemas: {} } },
      }) }],
    });
    expect(contract.application.id).toBe('tasks');
    expect(contract.resources).toHaveProperty('Task');
    expect(() => parseAppResourceContract({ content: [{ type: 'text', text: '{}' }] }))
      .toThrow(/invalid resource contract/);
  });

  it('propagates MCP tool annotations and reuses an identical connection', async () => {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [{
        name: 'player-list',
        description: 'List players.',
        inputSchema: { type: 'object' },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      }] }),
      callTool: vi.fn(),
    } as unknown as Pick<Client, 'connect' | 'close' | 'listTools' | 'callTool'>;
    const service = new AppMcpService({
      createClient: () => client,
      createTransport: () => ({} as Transport),
    });
    const endpoint = { transport: 'streamable-http' as const, url: 'http://localhost:4175/mcp' };
    await service.connect('sunset-chess', endpoint);
    await service.connect('sunset-chess', endpoint);
    expect(client.connect).toHaveBeenCalledOnce();
    const listing = await service.listToolsForRoute('sunset-chess', endpoint);
    expect(listing).toMatchObject({
      connectionId: expect.any(Number),
      endpoint,
    });
    expect(Object.isFrozen(listing.endpoint)).toBe(true);
    expect(await service.listTools('sunset-chess')).toEqual([expect.objectContaining({
      name: 'player-list',
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    })]);
    await service.disconnectAll();
  });

  it('reports connected only for the exact normalized endpoint', async () => {
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      callTool: vi.fn(),
    } as unknown as Pick<Client, 'connect' | 'close' | 'listTools' | 'callTool'>;
    const service = new AppMcpService({
      createClient: () => client,
      createTransport: () => ({} as Transport),
    });
    await service.connect('sunset-chess', {
      transport: 'streamable-http',
      url: 'http://localhost:4175/a/../mcp',
    });
    expect(service.status('sunset-chess', {
      transport: 'streamable-http', url: 'http://localhost:4175/mcp',
    })).toMatchObject({
      state: 'connected',
      endpoint: { url: 'http://localhost:4175/mcp' },
      connectionId: expect.any(Number),
    });
    expect(service.status('sunset-chess', {
      transport: 'streamable-http', url: 'http://localhost:4176/mcp',
    })).toMatchObject({ state: 'disconnected' });
    await service.disconnectAll();
  });

  it('rejects a pinned route after reconnecting to another endpoint without invoking it', async () => {
    const clients = [4175, 4176].map(() => ({
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: [{
        name: 'player-list', inputSchema: { type: 'object' },
      }] }),
      callTool: vi.fn().mockResolvedValue({}),
    }));
    let index = 0;
    const service = new AppMcpService({
      createClient: () => clients[index++] as unknown as Pick<Client, 'connect' | 'close' | 'listTools' | 'callTool'>,
      createTransport: () => ({} as Transport),
    });
    const oldEndpoint = { transport: 'streamable-http' as const, url: 'http://localhost:4175/mcp' };
    await service.connect('sunset-chess', oldEndpoint);
    const pinned = await service.listToolsForRoute('sunset-chess', oldEndpoint);
    await service.connect('sunset-chess', {
      transport: 'streamable-http', url: 'http://localhost:4176/mcp',
    });
    await expect(service.callTool('sunset-chess', 'player-list', {}, pinned))
      .rejects.toThrow(/connection changed.*Retry/i);
    expect(clients[0].callTool).not.toHaveBeenCalled();
    expect(clients[1].callTool).not.toHaveBeenCalled();
    await service.disconnectAll();
  });

  it('rejects a tool listing if the connection swaps while listing', async () => {
    let finishList!: (value: { tools: unknown[] }) => void;
    const clients = [{
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(() => new Promise((resolve) => { finishList = resolve; })),
      callTool: vi.fn(),
    }, {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn(),
      callTool: vi.fn(),
    }];
    let index = 0;
    const service = new AppMcpService({
      createClient: () => clients[index++] as unknown as Pick<Client, 'connect' | 'close' | 'listTools' | 'callTool'>,
      createTransport: () => ({} as Transport),
    });
    const oldEndpoint = { transport: 'streamable-http' as const, url: 'http://localhost:4175/mcp' };
    await service.connect('sunset-chess', oldEndpoint);
    const listing = service.listToolsForRoute('sunset-chess', oldEndpoint);
    await vi.waitFor(() => expect(clients[0].listTools).toHaveBeenCalledOnce());
    await service.connect('sunset-chess', {
      transport: 'streamable-http', url: 'http://localhost:4176/mcp',
    });
    finishList({ tools: [] });
    await expect(listing).rejects.toThrow(/changed while tools were being listed/);
    await service.disconnectAll();
  });

  it.each([
    'http://localhost:4175/mcp',
    'http://127.0.0.1:4175/mcp',
  ])('allows local HTTP endpoints: %s', (url) => {
    expect(validateAppMcpEndpoint({ transport: 'streamable-http', url }).href).toBe(url);
  });

  it.each([
    'https://localhost:4175/mcp',
    'http://example.com/mcp',
    'http://localhost:4175/mcp?token=secret',
    'http://localhost.:4175/mcp',
    'http://127.1:4175/mcp',
    'http://2130706433:4175/mcp',
    'http://[::1]:4175/mcp',
  ])('rejects unsafe endpoints: %s', (url) => {
    expect(() => validateAppMcpEndpoint({ transport: 'streamable-http', url })).toThrow();
  });

  it('rejects redirects without requesting their destination', async () => {
    let destinationRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === '/destination') {
        destinationRequests += 1;
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end('{}');
        return;
      }
      response.writeHead(302, { location: '/destination' });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    const service = new AppMcpService({ timeoutMs: 1_000 });
    try {
      await expect(service.connect('sunset-chess', {
        transport: 'streamable-http',
        url: `http://localhost:${port}/mcp`,
      })).rejects.toThrow(/HTTP 302 redirect.*redirects are not allowed/i);
      expect(destinationRequests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('closes and rejects a handshake completed after disconnectAll', async () => {
    let finishHandshake!: () => void;
    const handshake = new Promise<void>((resolve) => { finishHandshake = resolve; });
    const close = vi.fn().mockResolvedValue(undefined);
    const client = {
      connect: vi.fn(() => handshake),
      close,
      listTools: vi.fn(),
      callTool: vi.fn(),
    } as unknown as Pick<Client, 'connect' | 'close' | 'listTools' | 'callTool'>;
    const service = new AppMcpService({
      createClient: () => client,
      createTransport: () => ({} as Transport),
    });
    const endpoint = { transport: 'streamable-http' as const, url: 'http://localhost:4175/mcp' };
    const connecting = service.connect('sunset-chess', endpoint);
    await vi.waitFor(() => expect(client.connect).toHaveBeenCalledOnce());
    await service.disconnectAll();
    finishHandshake();
    await expect(connecting).rejects.toThrow(/cancelled/i);
    expect(close).toHaveBeenCalled();
    expect(service.status('sunset-chess', endpoint).state).toBe('disconnected');
  });
});
