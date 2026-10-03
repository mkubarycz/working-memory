import { describe, expect, it, vi } from 'vitest';
import {
  namespaceAppTools,
  appMentionSystemInstructions,
  normalizeAppAlias,
  resolveContainerAppMentions,
  resolveMentionedAppTools,
  type ContainerAppAliasDefinition,
} from '../src/main/appToolRouting';

const apps: ContainerAppAliasDefinition[] = [
  { id: 'sunset-chess', displayName: 'Sunset Chess', claimTitle: 'Sunset Chess Club', icon: 'chess' },
  { id: 'banking-app', displayName: 'Banking App', claimTitle: 'Banking', icon: 'bank' },
];

const readTool = {
  name: 'player-list',
  description: 'List players.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
};
const sunsetEndpoint = { transport: 'streamable-http' as const, url: 'http://localhost:4175/mcp' };
const bankingEndpoint = { transport: 'streamable-http' as const, url: 'http://localhost:4174/mcp' };

function listed(
  tools = [readTool],
  connectionId = 1,
  endpoint = sunsetEndpoint,
) {
  return { tools, connectionId, endpoint };
}

describe('Container App chat routing', () => {
  it.each([
    ['@Sunset-Chess add elliot', ['sunset-chess']],
    ['@sunset_chess show games', ['sunset-chess']],
    ['@Sunset Chess show games', ['sunset-chess']],
    ['@Sunset Chess Club show games', ['sunset-chess']],
    ['@sunset-chess and @SUNSET_CHESS list', ['sunset-chess']],
    ['normal prose without a mention', []],
    ['@sunset-chess compare @banking-app', ['sunset-chess', 'banking-app']],
    ['email user@sunset-chess.com', []],
    ['email user@example.com', []],
    ['identifier_@sunset-chess dotted.@banking-app path/@sunset-chess', []],
    ['(@sunset-chess), then @banking-app!', ['sunset-chess', 'banking-app']],
    ['@sunset-chess. Show games.', ['sunset-chess']],
    ['@sunset-chess.com is not a mention', []],
    ['@sunset-chess/path and @banking-app+suffix are continuations', []],
  ])('resolves %s', (text, expected) => {
    expect(resolveContainerAppMentions(text, apps).appIds).toEqual(expected);
  });

  it('normalizes case and separators', () => {
    expect(normalizeAppAlias(' Sunset_ Chess ')).toBe('sunset-chess');
  });

  it('uses locale-independent ASCII casing for uppercase aliases', () => {
    const localeLower = vi.spyOn(String.prototype, 'toLocaleLowerCase')
      .mockImplementation(() => { throw new Error('locale-sensitive lowercasing used'); });
    try {
      expect(normalizeAppAlias('BANKING_APP')).toBe('banking-app');
      expect(resolveContainerAppMentions('@BANKING_APP list', apps).appIds).toEqual(['banking-app']);
    } finally {
      localeLower.mockRestore();
    }
  });

  it('rejects unknown and ambiguous mentions with canonical choices', () => {
    expect(() => resolveContainerAppMentions('@unknown do it', apps))
      .toThrow(/Unknown.*@unknown.*@sunset-chess.*@banking-app/);
    const ambiguous = [
      ...apps,
      { id: 'clarinet-hero' as const, displayName: 'Banking App', icon: 'music' },
    ];
    expect(() => resolveContainerAppMentions('@Banking App do it', ambiguous))
      .toThrow(/Ambiguous.*@banking-app.*@clarinet-hero.*canonical @app-id/);
  });

  it('creates stable, valid, collision-proof provider names and an explicit route map', () => {
    const first = namespaceAppTools([
      { id: 'sunset-chess', displayName: 'Sunset Chess', connectionId: 7, endpoint: sunsetEndpoint, tools: [
        readTool,
        { ...readTool, name: `very long tool ${'x'.repeat(100)}` },
      ] },
      { id: 'banking-app', displayName: 'Banking App', connectionId: 8, endpoint: bankingEndpoint, tools: [readTool] },
    ]);
    const second = namespaceAppTools([
      { id: 'banking-app', displayName: 'Banking App', connectionId: 8, endpoint: bankingEndpoint, tools: [readTool] },
      { id: 'sunset-chess', displayName: 'Sunset Chess', connectionId: 7, endpoint: sunsetEndpoint, tools: [
        { ...readTool, name: `very long tool ${'x'.repeat(100)}` },
        readTool,
      ] },
    ]);
    expect([...first.routes.keys()]).toEqual([...second.routes.keys()]);
    expect(new Set(first.routes.keys()).size).toBe(3);
    for (const name of first.routes.keys()) {
      expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(name.length).toBeLessThanOrEqual(64);
    }
    expect(first.routes.get('app__sunset-chess__player-list')).toMatchObject({
      appId: 'sunset-chess',
      originalToolName: 'player-list',
      connectionId: 7,
      endpoint: sunsetEndpoint,
    });
  });

  it('rejects duplicate routes explicitly', () => {
    expect(() => namespaceAppTools([
      { id: 'sunset-chess', displayName: 'Sunset Chess', connectionId: 1, endpoint: sunsetEndpoint, tools: [readTool, readTool] },
    ])).toThrow(/duplicate MCP tool/);
  });

  it('does no app work without a mention', async () => {
    const readClaim = vi.fn();
    const result = await resolveMentionedAppTools('show my topics', apps, {
      readClaim,
      inspect: vi.fn(),
      connect: vi.fn(),
      listTools: vi.fn(),
    });
    expect(result.tools).toEqual([]);
    expect(readClaim).not.toHaveBeenCalled();
  });

  it('routes an implicit selected app exactly like an explicit mention without rewriting text', async () => {
    const dependencies = () => ({
      readClaim: async (appId: string) => ({
        slug: appId,
        title: apps.find((app) => app.id === appId)?.displayName ?? appId,
        repository: `/source/${appId}`,
        mcp: appId === 'sunset-chess' ? sunsetEndpoint : bankingEndpoint,
        application: appId === 'sunset-chess' ? {
          id: 'sunset-chess',
          contractVersion: '1.0',
          discovery: { toolName: 'contract-discover' },
          capabilities: ['contract-discovery'],
          dataOwnership: 'application' as const,
        } : undefined,
      }),
      inspect: async () => ({ ready: true, state: 'healthy', error: null }),
      connect: async () => undefined,
      listTools: async (_appId: string, endpoint: typeof sunsetEndpoint) => listed([
        {
          name: 'contract-discover',
          description: 'Discover the live contract.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
        readTool,
      ], 9, endpoint),
    });

    const implicit = await resolveMentionedAppTools(
      'list players',
      apps,
      dependencies(),
      ['sunset-chess'],
    );
    const explicit = await resolveMentionedAppTools(
      '@sunset-chess list players',
      apps,
      dependencies(),
    );

    expect(implicit.tools).toEqual(explicit.tools);
    expect([...implicit.routes.entries()]).toEqual([...explicit.routes.entries()]);
    expect(implicit.contexts).toEqual(explicit.contexts);
    expect(appMentionSystemInstructions(implicit.contexts))
      .toEqual(appMentionSystemInstructions(explicit.contexts));
  });

  it('uses the live claim MCP endpoint as source of truth', async () => {
    const connect = vi.fn();
    const result = await resolveMentionedAppTools('@sunset-chess list players', apps, {
      readClaim: async (appId) => appId === 'sunset-chess' ? ({
        slug: appId, title: 'Sunset', repository: '/source',
        mcp: { transport: 'streamable-http', url: 'http://localhost:4999/current' },
        application: {
          id: 'sunset-chess',
          contractVersion: '1.2.0',
          discovery: { toolName: 'app-contract-get' },
          capabilities: ['generic-crud'],
          dataOwnership: 'application',
        },
      }) : ({ slug: appId, title: 'Banking', repository: '/banking' }),
      inspect: async () => ({ ready: true, state: 'healthy', error: null }),
      connect,
      listTools: async (_appId, endpoint) => listed([
        {
          name: 'app-contract-get',
          description: 'Get contract.',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
        readTool,
      ], 11, endpoint),
    });
    expect(connect).toHaveBeenCalledWith('sunset-chess', {
      transport: 'streamable-http', url: 'http://localhost:4999/current',
    });
    expect(result.tools[0].description).toContain('@sunset-chess');
    expect([...result.routes.values()][0]).toMatchObject({
      connectionId: 11,
      endpoint: { url: 'http://localhost:4999/current' },
    });
    expect(result.contexts[0]).toMatchObject({
      appId: 'sunset-chess',
      claimSlug: 'sunset-chess',
      contractVersion: '1.2.0',
      discoveryModelTool: 'app__sunset-chess__app-contract-get',
      dataOwnership: 'application',
    });
    expect(appMentionSystemInstructions(result.contexts)).toMatch(
      /Before any other.*contract-discovery.*plan the resource envelopes and relationships/is,
    );
  });

  it('resolves a current claim title alias without making prose mentions greedy', async () => {
    const result = await resolveMentionedAppTools('@Evening Knights list players', apps, {
      readClaim: async (appId) => appId === 'sunset-chess'
        ? {
          slug: appId, title: 'Evening Knights', repository: '/source',
          mcp: { transport: 'streamable-http', url: 'http://localhost:4175/mcp' },
        }
        : { slug: appId, title: 'Banking', repository: '/banking' },
      inspect: async () => ({ ready: true, state: 'healthy', error: null }),
      connect: async () => undefined,
      listTools: async (_appId, endpoint) => listed([readTool], 1, endpoint),
    });
    expect([...result.routes.values()][0]).toMatchObject({ appId: 'sunset-chess' });
  });

  it('does not require claims for unmentioned registered apps', async () => {
    const result = await resolveMentionedAppTools('@sunset-chess list players', apps, {
      readClaim: async (appId) => appId === 'sunset-chess'
        ? {
          slug: appId,
          title: 'Sunset',
          repository: '/source',
          mcp: sunsetEndpoint,
        }
        : undefined,
      inspect: async () => ({ ready: true, state: 'healthy', error: null }),
      connect: async () => undefined,
      listTools: async (_appId, endpoint) => listed([readTool], 1, endpoint),
    });

    expect([...result.routes.values()][0]).toMatchObject({ appId: 'sunset-chess' });
  });

  it('reports no claim, no MCP, and unhealthy apps before connecting', async () => {
    const common = { inspect: vi.fn(), connect: vi.fn(), listTools: vi.fn() };
    await expect(resolveMentionedAppTools('@sunset-chess list', apps, {
      ...common, readClaim: async () => undefined,
    })).rejects.toThrow(/no ContainerClaim/);
    await expect(resolveMentionedAppTools('@banking-app add a transaction', apps, {
      ...common,
      readClaim: async (appId) => appId === 'banking-app'
        ? { slug: appId, title: 'Banking', repository: '/source' }
        : undefined,
    })).rejects.toThrow(/does not advertise MCP/);
    await expect(resolveMentionedAppTools('@sunset-chess list', apps, {
      ...common,
      readClaim: async (appId) => appId === 'sunset-chess' ? ({
        slug: appId, title: 'Sunset', repository: '/source',
        mcp: { transport: 'streamable-http', url: 'http://localhost:4175/mcp' },
      }) : undefined,
      inspect: async () => ({ ready: false, state: 'stopped', error: null }),
    })).rejects.toThrow(/not healthy.*Run it.*wait for healthy/i);
  });
});
