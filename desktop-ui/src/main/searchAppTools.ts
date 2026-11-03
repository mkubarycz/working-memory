import type { ContainerClaim, ControlPlaneClient } from '../../../shared/controlPlaneClient';
import type { AppMcpService } from './appMcpService';
import { normalizeAppMcpEndpoint } from './appMcpService';
import { namespaceAppTools, type AppToolRoute } from './appToolRouting';
import type { CanonicalToolDef } from '../../../shared/controlPlaneClient';
import { containerAppDefinitions } from './containerAppRegistry';

export interface SearchAppInfo {
  id: string;
  title: string;
  capabilities: string[];
  mcpAvailable: boolean;
}

export interface SearchAppDiscovery {
  app: SearchAppInfo;
  tools: CanonicalToolDef[];
}

export class SearchAppTools {
  private readonly routes = new Map<string, AppToolRoute>();
  private readonly opened = new Set<string>();

  constructor(private readonly dependencies: {
    client: Pick<ControlPlaneClient, 'containerClaimRead'>;
    mcp: Pick<AppMcpService, 'connect' | 'listToolsForRoute' | 'callTool'>;
    inspect: (claim: ContainerClaim) => Promise<{ ready: boolean; state: string; error: string | null }>;
    assertCurrent: () => void;
  }) {}

  async list(): Promise<SearchAppInfo[]> {
    this.dependencies.assertCurrent();
    const claims = await this.dependencies.client.containerClaimRead();
    this.dependencies.assertCurrent();
    return containerAppDefinitions(claims).map(app => ({
      id: app.id, title: app.displayName,
      capabilities: app.application?.capabilities ?? [],
      mcpAvailable: Boolean(app.mcp),
    }));
  }

  async discover(id: string): Promise<SearchAppDiscovery> {
    if (!this.opened.has(id) && this.opened.size >= 4) throw new Error('Search can inspect at most four registered apps per request.');
    const claim = await this.claim(id);
    if (!claim.mcp) throw new Error(`Registered app ${id} does not advertise MCP.`);
    const status = await this.dependencies.inspect(claim);
    this.dependencies.assertCurrent();
    if (!status.ready) throw new Error(`Registered app ${id} is not ready (${status.state}).${status.error ? ` ${status.error}` : ''}`);
    await this.dependencies.mcp.connect(id, claim.mcp);
    this.dependencies.assertCurrent();
    const listing = await this.dependencies.mcp.listToolsForRoute(id, claim.mcp);
    this.dependencies.assertCurrent();
    const tools = listing.tools.filter(tool => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true);
    if (tools.length > 48 || JSON.stringify(tools).length > 48000) {
      throw new Error(`Registered app ${id} exposes too many read-only tool schemas for one search.`);
    }
    const namespaced = namespaceAppTools([{
      id, displayName: claim.title, tools, connectionId: listing.connectionId, endpoint: listing.endpoint,
    }]);
    for (const [name, route] of namespaced.routes) this.routes.set(name, route);
    this.opened.add(id);
    return { app: { id, title: claim.title, capabilities: claim.application?.capabilities ?? [], mcpAvailable: true },
      tools: namespaced.tools };
  }

  async call(name: string, args: Record<string, unknown>): Promise<{ appId: string; title: string; result: unknown }> {
    const route = this.routes.get(name);
    if (!route || route.annotations?.readOnlyHint !== true || route.annotations.destructiveHint === true) {
      throw new Error('Search cannot execute unlisted or mutating application tools.');
    }
    const claim = await this.claim(route.appId);
    if (!claim.mcp || normalizeAppMcpEndpoint(claim.mcp).url !== route.endpoint.url) throw new Error('The registered application endpoint changed. Search again.');
    const listing = await this.dependencies.mcp.listToolsForRoute(route.appId, claim.mcp);
    this.dependencies.assertCurrent();
    const tool = listing.tools.find(candidate => candidate.name === route.originalToolName);
    if (listing.connectionId !== route.connectionId || tool?.annotations?.readOnlyHint !== true || tool.annotations.destructiveHint === true) {
      throw new Error('The application tool changed or is no longer read-only. Search again.');
    }
    const result = await this.dependencies.mcp.callTool(route.appId, route.originalToolName, args, route);
    this.dependencies.assertCurrent();
    return { appId: route.appId, title: route.appDisplayName, result };
  }

  private async claim(id: string): Promise<ContainerClaim> {
    this.dependencies.assertCurrent();
    const [claim] = await this.dependencies.client.containerClaimRead({ id });
    this.dependencies.assertCurrent();
    if (!claim?.runtime || claim.id !== id) throw new Error(`Application ${id} is not a registered container app.`);
    return claim;
  }
}
