import { createHash } from 'node:crypto';
import type { CanonicalToolDef, DockerRuntimeSpec } from '../../../shared/controlPlaneClient';
import type {
  AppMcpTool,
  AppMcpToolListing,
  ContainerAppDefinition,
  ContainerAppId,
  McpToolAnnotations,
} from '../shared/contracts';
import {
  isSafeMentionStart,
  isSafeMentionTerminator,
  normalizeAppAlias,
} from '../shared/mentionSyntax';
export { normalizeAppAlias } from '../shared/mentionSyntax';

export interface ContainerAppAliasDefinition extends ContainerAppDefinition {
  claimTitle?: string;
  aliases?: string[];
}

export interface MentionResolution {
  appIds: ContainerAppId[];
  mentions: Array<{ raw: string; appId: ContainerAppId }>;
}

export interface AppToolRoute {
  appId: ContainerAppId;
  appDisplayName: string;
  originalToolName: string;
  modelName: string;
  connectionId: number;
  endpoint: import('../shared/contracts').AppMcpEndpoint;
  annotations?: McpToolAnnotations;
}

export interface NamespacedAppTools {
  tools: CanonicalToolDef[];
  routes: Map<string, AppToolRoute>;
  contexts: AppMentionContext[];
}

export interface AppMentionContext {
  appId: ContainerAppId;
  displayName: string;
  claimSlug: string;
  claimTitle: string;
  repository: string;
  endpoint: import('../shared/contracts').AppMcpEndpoint;
  contractVersion?: string;
  discoveryTool?: string;
  discoveryModelTool?: string;
  capabilities: string[];
  dataOwnership?: 'application';
  uiUrl?: string;
  httpUrl?: string;
}

export interface LiveAppClaim {
  slug: string;
  title: string;
  repository: string;
  runtime?: DockerRuntimeSpec;
  mcp?: import('../shared/contracts').AppMcpEndpoint;
  application?: import('../../../shared/controlPlaneClient').ApplicationContractMetadata;
}

export interface AppToolResolutionDependencies {
  readClaim: (appId: ContainerAppId) => Promise<LiveAppClaim | undefined>;
  inspect: (claim: LiveAppClaim) => Promise<{ ready: boolean; state: string; error: string | null }>;
  connect: (appId: ContainerAppId, endpoint: NonNullable<LiveAppClaim['mcp']>) => Promise<void>;
  listTools: (
    appId: ContainerAppId,
    endpoint: NonNullable<LiveAppClaim['mcp']>,
  ) => Promise<AppMcpToolListing>;
}

const MAX_MENTIONED_APPS = 4;
const MAX_APP_TOOLS = 64;
const MAX_APP_SCHEMA_BYTES = 128 * 1024;

const MODEL_NAME = /^[A-Za-z0-9_-]+$/;
const MAX_MODEL_NAME_LENGTH = 64;

export function resolveContainerAppMentions(
  text: string,
  definitions: readonly ContainerAppAliasDefinition[],
): MentionResolution {
  const aliases = new Map<string, ContainerAppAliasDefinition[]>();
  for (const definition of definitions) {
    for (const value of [definition.id, definition.displayName, definition.claimTitle, ...(definition.aliases ?? [])]) {
      if (!value?.trim()) continue;
      const key = normalizeAppAlias(value);
      const entries = aliases.get(key) ?? [];
      if (!entries.some((entry) => entry.id === definition.id)) entries.push(definition);
      aliases.set(key, entries);
    }
  }

  const mentions: MentionResolution['mentions'] = [];
  const unknown: string[] = [];
  const ambiguous: Array<{ raw: string; names: string[] }> = [];
  const pattern = /@([A-Za-z0-9][A-Za-z0-9_-]*(?:[ \t]+[A-Za-z0-9][A-Za-z0-9_-]*)*)/g;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (!isSafeMentionStart(text, start)) continue;
    const words = match[1].trim().split(/[ \t]+/);
    let matched: { raw: string; definitions: ContainerAppAliasDefinition[] } | undefined;
    for (let length = words.length; length > 0; length -= 1) {
      const raw = words.slice(0, length).join(' ');
      const candidates = aliases.get(normalizeAppAlias(raw));
      if (candidates?.length) {
        matched = { raw: `@${raw}`, definitions: candidates };
        break;
      }
    }
    if (!matched) {
      unknown.push(`@${words[0]}`);
      continue;
    }
    const end = start + matched.raw.length;
    if (!isSafeMentionTerminator(text, end)) continue;
    if (matched.definitions.length > 1) {
      ambiguous.push({
        raw: matched.raw,
        names: matched.definitions.map((definition) => `@${definition.id}`),
      });
      continue;
    }
    mentions.push({ raw: matched.raw, appId: matched.definitions[0].id });
  }

  const available = definitions.map((definition) => `@${definition.id}`).join(', ') || 'none';
  if (unknown.length) {
    throw new Error(`Unknown Container App mention ${unique(unknown).join(', ')}. Available apps: ${available}.`);
  }
  if (ambiguous.length) {
    const detail = ambiguous.map((entry) => `${entry.raw} (${unique(entry.names).join(' or ')})`).join(', ');
    throw new Error(`Ambiguous Container App mention: ${detail}. Use the canonical @app-id.`);
  }
  return { appIds: unique(mentions.map((mention) => mention.appId)), mentions };
}

export function namespaceAppTools(
  apps: ReadonlyArray<{
    id: ContainerAppId;
    displayName: string;
    tools: readonly AppMcpTool[];
    connectionId: number;
    endpoint: import('../shared/contracts').AppMcpEndpoint;
  }>,
): NamespacedAppTools {
  const routes = new Map<string, AppToolRoute>();
  const descriptors: CanonicalToolDef[] = [];
  const originalRoutes = new Set<string>();
  const ordered = [...apps].sort((left, right) => left.id.localeCompare(right.id));
  for (const app of ordered) {
    for (const tool of [...app.tools].sort((left, right) => left.name.localeCompare(right.name))) {
      validateTool(app.id, tool);
      const originalKey = `${app.id}\0${tool.name}`;
      if (originalRoutes.has(originalKey)) {
        throw new Error(`Container App @${app.id} advertised duplicate MCP tool "${tool.name}".`);
      }

      originalRoutes.add(originalKey);
      const readable = `app__${safeSegment(app.id)}__${safeSegment(tool.name)}`;
      let modelName = readable.slice(0, MAX_MODEL_NAME_LENGTH);
      if (readable.length > MAX_MODEL_NAME_LENGTH || routes.has(modelName)) {
        const suffix = `__${stableHash(originalKey)}`;
        modelName = `${readable.slice(0, MAX_MODEL_NAME_LENGTH - suffix.length)}${suffix}`;
      }
      if (routes.has(modelName)) {
        throw new Error(`Container App MCP tools could not be assigned a unique model name for @${app.id} "${tool.name}".`);
      }
      const route: AppToolRoute = {
        appId: app.id,
        appDisplayName: app.displayName,
        originalToolName: tool.name,
        modelName,
        connectionId: app.connectionId,
        endpoint: app.endpoint,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
      };
      routes.set(modelName, route);
      descriptors.push({
        name: modelName,
        description: `Container App "${app.displayName}" (@${app.id}) MCP tool "${tool.name}". ${tool.description ?? ''}`.trim(),
        inputSchema: tool.inputSchema,
      });
    }
  }
  return { tools: descriptors, routes, contexts: [] };
}

export async function resolveMentionedAppTools(
  message: string,
  definitions: readonly ContainerAppAliasDefinition[],
  dependencies: AppToolResolutionDependencies,
  implicitAppIds: readonly ContainerAppId[] = [],
): Promise<NamespacedAppTools> {
  const hasExplicitMention = /@[A-Za-z0-9]/.test(message);
  if (!hasExplicitMention && implicitAppIds.length === 0) {
    return { tools: [], routes: new Map(), contexts: [] };
  }
  const claims = new Map<ContainerAppId, LiveAppClaim | undefined>();
  try {
    await Promise.all(definitions.map(async (definition) => {
      claims.set(definition.id, await dependencies.readClaim(definition.id));
    }));
  } catch (error) {
    throw new Error(`Unable to resolve Container App mentions from current ContainerClaims: ${errorMessage(error)}`);
  }
  const definitionsWithAliases = definitions.map((definition) => {
    const claim = claims.get(definition.id);
    return {
      ...definition,
      aliases: [...(definition.aliases ?? []), ...(claim ? [claim.slug, claim.title] : [])],
    };
  });
  const explicitlyMentioned = hasExplicitMention
    ? resolveContainerAppMentions(message, definitionsWithAliases)
    : { appIds: [], mentions: [] };
  const appIds = unique([...implicitAppIds, ...explicitlyMentioned.appIds]);
  if (!appIds.length) return { tools: [], routes: new Map(), contexts: [] };
  if (appIds.length > MAX_MENTIONED_APPS) {
    throw new Error(`Mention at most ${MAX_MENTIONED_APPS} Container Apps in one chat request.`);
  }
  const resolved = [];
  for (const appId of appIds) {
    const definition = definitions.find((candidate) => candidate.id === appId);
    if (!definition) throw new Error(`Container App @${appId} is no longer registered.`);
    const claim = claims.get(appId);
    if (!claim) {
      throw new Error(`Container App @${appId} has no ContainerClaim. Open Container Apps and run it once to create the claim.`);
    }
    if (!claim.mcp) {
      throw new Error(`Container App @${appId} does not advertise MCP in its current ContainerClaim.`);
    }
    const status = await dependencies.inspect(claim);
    if (!status.ready) {
      const detail = status.error ? ` ${status.error}` : '';
      throw new Error(`Container App @${appId} is not healthy (state: ${status.state}). Run it from Container Apps and wait for healthy status.${detail}`);
    }
    try {
      await dependencies.connect(appId, claim.mcp);
    } catch (error) {
      throw new Error(`Unable to connect to @${appId} MCP endpoint from its ContainerClaim: ${errorMessage(error)}`);
    }
    let listing: AppMcpToolListing;
    try {
      listing = await dependencies.listTools(appId, claim.mcp);
    } catch (error) {
      throw new Error(`Unable to list MCP tools for @${appId}: ${errorMessage(error)}`);
    }
    if (!listing.tools.length) throw new Error(`Container App @${appId} advertises MCP but exposes no tools.`);
    resolved.push({
      id: appId,
      displayName: definition.displayName,
      tools: listing.tools,
      connectionId: listing.connectionId,
      endpoint: listing.endpoint,
    });
  }
  const count = resolved.reduce((sum, app) => sum + app.tools.length, 0);
  if (count > MAX_APP_TOOLS) {
    throw new Error(`Mentioned Container Apps expose ${count} tools; the chat limit is ${MAX_APP_TOOLS}.`);
  }
  const schemaBytes = Buffer.byteLength(JSON.stringify(resolved.map((app) =>
    app.tools.map((tool) => tool.inputSchema))));
  if (schemaBytes > MAX_APP_SCHEMA_BYTES) {
    throw new Error(`Mentioned Container App MCP schemas exceed the ${MAX_APP_SCHEMA_BYTES}-byte chat limit.`);
  }
  const namespaced = namespaceAppTools(resolved);
  for (const name of namespaced.routes.keys()) assertProviderSafeToolName(name);
  namespaced.contexts = resolved.map((app) => {
    const claim = claims.get(app.id)!;
    const discoveryTool = claim.application?.discovery.toolName;
    const discoveryModelTool = discoveryTool
      ? [...namespaced.routes.values()].find(
        (route) => route.appId === app.id && route.originalToolName === discoveryTool,
      )?.modelName
      : undefined;
    return {
      appId: app.id,
      displayName: app.displayName,
      claimSlug: claim.slug,
      claimTitle: claim.title,
      repository: claim.repository,
      endpoint: app.endpoint,
      ...(claim.application ? {
        contractVersion: claim.application.contractVersion,
        capabilities: claim.application.capabilities,
        dataOwnership: claim.application.dataOwnership,
        uiUrl: claim.application.uiUrl,
        httpUrl: claim.application.httpUrl,
      } : { capabilities: [] }),
      ...(discoveryTool ? { discoveryTool } : {}),
      ...(discoveryModelTool ? { discoveryModelTool } : {}),
    };
  });
  return namespaced;
}

export function appMentionSystemInstructions(contexts: readonly AppMentionContext[]): string {
  if (!contexts.length) return '';
  const identity = contexts.map((context) => JSON.stringify({
    id: context.appId,
    title: context.displayName,
    claim: { slug: context.claimSlug, title: context.claimTitle, repository: context.repository },
    connection: { transport: context.endpoint.transport, url: context.endpoint.url },
    contractVersion: context.contractVersion,
    capabilities: context.capabilities,
    dataOwnership: context.dataOwnership,
    uiUrl: context.uiUrl,
    httpUrl: context.httpUrl,
    contractDiscoveryTool: context.discoveryModelTool,
  }));
  const missing = contexts.filter((context) => !context.discoveryModelTool).map((context) => `@${context.appId}`);
  return [
    `Mentioned application context: ${identity.join('; ')}.`,
    'Before any other mentioned-app operation, call each application contract-discovery tool to obtain its live Zod-derived resource contract and business rules.',
    'Then explicitly plan the resource envelopes and relationships needed by the request before invoking read or mutation tools.',
    'Use the live contract as authoritative; do not infer business rules from tool names or Working Memory metadata.',
    ...(missing.length ? [`No advertised contract-discovery tool was found for ${missing.join(', ')}; explain that limitation instead of guessing.`] : []),
  ].join(' ');
}

function validateTool(appId: string, tool: AppMcpTool): void {
  if (!tool.name.trim()) throw new Error(`Container App @${appId} advertised an MCP tool with no name.`);
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
    throw new Error(`Container App @${appId} MCP tool "${tool.name}" has an invalid input schema.`);
  }
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return safe || 'tool';
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 10);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


export function assertProviderSafeToolName(name: string): void {
  if (!MODEL_NAME.test(name) || name.length > MAX_MODEL_NAME_LENGTH) {
    throw new Error(`Invalid provider tool name "${name}".`);
  }
}
