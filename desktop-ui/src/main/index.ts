import { app, BrowserWindow, dialog, ipcMain, nativeImage, safeStorage, screen, shell } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ControlPlaneClient } from '../../../shared/controlPlaneClient';
import { renderDocumentByKind } from './documentRenderers';
import type {
  ChatContext,
  ChatPromptImage,
  ChatResult,
  DesktopEnvironmentState,
  PreparedResourceDrag,
  DesktopResourceKind,
  SaveConfigInput,
  TopicAutocompleteInput,
  TopicAutocompleteResult,
} from '../shared/contracts';
import type { CommandJournalHistoryInput } from '../../../shared/controlPlaneClient';
import type { ContainerClaim, ToolCallOutcome } from '../../../shared/controlPlaneClient';
import type { DocumentVM, TopicPatch } from '../renderer/documents/types';
import {
  modelAuthHeaders,
  modelEndpoint,
  modelProfiles,
  publicConfig,
  readStoredConfig,
  resolveModelProfile,
  writeStoredConfig,
  type StoredConfig,
  type StoredModelProfile,
} from './config';
import { checkConfiguredModel } from './modelHealth';
import {
  DESKTOP_MODEL_REQUEST_TIMEOUT_MS,
  DesktopChatAgent,
  type DesktopAgentResult,
  type ModelHttpRequest,
} from './desktopChatAgent';
import {
  DesktopEnvironmentManager,
  readPersistedEnvironment,
  writePersistedEnvironment,
} from './environments';
import { parseModelTurn } from './modelTools';
import { AppMcpService, parseAppResourceContract } from './appMcpService';
import {
  appMentionSystemInstructions,
  resolveMentionedAppTools,
} from './appToolRouting';
import {
  containerAppDefinitions,
  containerAppRegistration,
  isContainerAppId,
  type ContainerAppRegistration,
} from './containerAppRegistry';
import {
  DockerContainerService,
  resolveContainerAppClaim,
} from './dockerContainerService';
import { createGracefulShutdown } from './gracefulShutdown';
import {
  readWindowBounds,
  resolveWindowBounds,
  writeWindowBounds,
  writeWindowBoundsSync,
} from './windowState';
import {
  chooseWorkstream,
  loadActivePanelData,
  persistWorkstreamReorder,
  loadTopicViewModel,
  loadWorkstreamViewModel,
  localWorkstreamQuery,
  resolveDesktopAction,
  toGenericDocumentViewModel,
} from './resolver';
import {
  parseDesktopDeepLink,
  WORKING_MEMORY_PROTOCOL,
  type DesktopDeepLinkTarget,
} from '../shared/deepLink';
import { DesktopLinkBridge } from './linkBridge';
import { resourceDragFilename } from './resourceDragContext';
import { DesktopCredentialVault } from './credentialVault';
import { loadPromptImages } from './promptImages';
import { decodeQrPayloads } from './qrDecoder';

const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const STABLE_DESKTOP_EXECUTABLE = '/Applications/Working Memory.app/Contents/MacOS/Electron';
const WINDOW_DEFAULTS = { defaultWidth: 1280, defaultHeight: 820, minWidth: 900, minHeight: 600 };
const WINDOW_STATE_SAVE_DELAY_MS = 250;
let configFile = '';
let credentialVault: DesktopCredentialVault | null = null;
let credentialMigrationError = '';
let environmentFile = '';
let windowStateFile = '';
let mainWindow: BrowserWindow | null = null;
let mainWindowCreation: Promise<BrowserWindow> | null = null;
let windowStateSaveTimer: ReturnType<typeof setTimeout> | undefined;
let pendingDeepLink: DesktopDeepLinkTarget | null = null;
let desktopLinkBridge: DesktopLinkBridge | null = null;
const dockerContainers = new DockerContainerService();
const appMcp = new AppMcpService();
const containerOperations = new Set<AbortController>();
let containerEnvironmentGeneration = 0;

const environmentManager = new DesktopEnvironmentManager<ControlPlaneClient>({
  createClient: (mcpUrl) => new ControlPlaneClient({ resolveUrl: () => mcpUrl }),
  readPersistedSelection: () => readPersistedEnvironment(environmentFile),
  writePersistedSelection: (mcpUrl) => writePersistedEnvironment(environmentFile, mcpUrl),
});

function controlPlane(): ControlPlaneClient {
  return environmentManager.currentClient;
}

function environmentState(environments = [] as DesktopEnvironmentState['environments']): DesktopEnvironmentState {
  return { environments, selected: environmentManager.currentEnvironment };
}

const chatAgent = new DesktopChatAgent({
  listTools: () => controlPlane().listTools(),
  callTool: (name, args) => controlPlane().callTool(name, args),
  callModel: requestModel,
  journal: {
    create: (input) => controlPlane().commandJournalCreate(input),
    append: (input) => controlPlane().commandJournalAppend(input),
    finalize: (input) => controlPlane().commandJournalFinalize(input),
  },
  resolveDependencies: () => {
    const client = controlPlane();
    return {
      listTools: () => client.listTools(),
      callTool: (name, args) => client.callTool(name, args),
      journal: {
        create: (input) => client.commandJournalCreate(input),
        append: (input) => client.commandJournalAppend(input),
        finalize: (input) => client.commandJournalFinalize(input),
      },
    };
  },
});

const gracefulShutdown = createGracefulShutdown({
  resetAgent: async () => {
    await chatAgent.reset();
    await appMcp.disconnectAll();
    await desktopLinkBridge?.close();
  },
  disposeEnvironment: () => environmentManager.dispose(),
  quit: () => app.quit(),
  onError: (error) => console.error('[desktop] graceful shutdown failed:', error),
});

function decryptApiKey(config: StoredConfig): string {
  if (credentialMigrationError) throw new Error(credentialMigrationError);
  if (!credentialVault) throw new Error('Credential storage has not been initialized');
  return credentialVault.decrypt(config);
}

async function saveConfig(input: SaveConfigInput): Promise<StoredConfig> {
  if (!credentialVault) throw new Error('Credential storage has not been initialized');
  if (!input.profiles.length) throw new Error('Add at least one model profile.');
  const current = await readStoredConfig(configFile);
  const currentProfiles = new Map(modelProfiles(current).map((profile) => [profile.id, profile]));
  const ids = new Set<string>();
  const profiles: StoredModelProfile[] = input.profiles.map((profile) => {
    const id = profile.id.trim();
    const name = profile.name.trim();
    if (!id || !name || !profile.model.trim()) {
      throw new Error('Every model profile needs a name and model.');
    }
    if (ids.has(id)) throw new Error(`Duplicate model profile id: ${id}`);
    ids.add(id);
    const previous = currentProfiles.get(id);
    const base: StoredConfig = {
      endpoint: profile.endpoint,
      model: profile.model,
      ...(previous?.encryptedApiKey ? { encryptedApiKey: previous.encryptedApiKey } : {}),
    };
    const stored = credentialVault!.store(base, profile.apiKey);
    return {
      id,
      name,
      endpoint: stored.endpoint,
      model: stored.model,
      ...(stored.encryptedApiKey ? { encryptedApiKey: stored.encryptedApiKey } : {}),
    };
  });
  const primary = profiles[0];
  const next: StoredConfig = {
    endpoint: primary.endpoint,
    model: primary.model,
    ...(primary.encryptedApiKey ? { encryptedApiKey: primary.encryptedApiKey } : {}),
    humanName: input.humanName.trim() || 'Flesh Bag',
    profiles,
    routing: input.routing,
  };
  await writeStoredConfig(configFile, next);
  if (input.profiles.some((profile) => profile.apiKey?.trim())) credentialMigrationError = '';
  return next;
}

async function openWorkstream(query: string): Promise<ChatResult> {
  const workstreams = await controlPlane().wsRead({ limit: 200 });
  const workstream = chooseWorkstream(query, workstreams);
  if (!workstream) {
    return { message: `I couldn't find a workstream matching “${query}”.`, status: 'failed' };
  }
  return {
    message: `Opened ${workstream.title}.`,
    status: 'succeeded',
    workstream: (await loadWorkstreamViewModel(controlPlane(), workstream.slug ?? workstream.id)) ?? undefined,
  };
}

async function loadResource(
  kind: DesktopResourceKind,
  identifier: string,
): Promise<DocumentVM> {
  if (!identifier.trim()) throw new Error('A document identifier is required.');
  if (kind === 'workstream') {
    const document = await loadWorkstreamViewModel(controlPlane(), identifier);
    if (document) return document;
  } else if (kind === 'topic') {
    const document = await loadTopicViewModel(controlPlane(), identifier);
    if (document) return document;
  } else {
    const controlPlaneKind = kind === 'alert' ? 'Alert' : kind === 'topic-type' ? 'TopicType' : undefined;
    let result = await controlPlane().getDocument({ id: identifier, ...(controlPlaneKind ? { kind: controlPlaneKind } : {}) });
    if (result.available && !result.document && controlPlaneKind) {
      result = await controlPlane().getDocument({ slug: identifier, kind: controlPlaneKind });
    }
    if (!result.available) throw new Error(result.error ?? 'Control plane is unavailable.');
    if (result.document) return toGenericDocumentViewModel(result.document);
  }
  throw new Error(`Working Memory ${kind} "${identifier}" was not found.`);
}

const RESOURCE_URI_RE =
  /^working-memory:\/(?:\/)?(workstream|topic|document|alert|topic-type)\/([^/]+)\.working-memory$/;

function createDragIcon(): Electron.NativeImage {
  const size = 16;
  const bitmap = Buffer.alloc(size * size * 4);
  for (const y of [4, 7, 10]) {
    for (let x = 3; x <= 12; x += 1) {
      const offset = (y * size + x) * 4;
      bitmap[offset] = 157;
      bitmap[offset + 1] = 75;
      bitmap[offset + 2] = 242;
      bitmap[offset + 3] = 255;
    }
  }
  return nativeImage.createFromBitmap(bitmap, {
    width: size,
    height: size,
    scaleFactor: 1,
  });
}

function dragContextDirectory(): string {
  return join(app.getPath('temp'), 'working-memory-chat-context');
}

function isDragContextFile(filePath: string): boolean {
  const root = resolve(dragContextDirectory());
  const candidate = resolve(filePath);
  const rel = relative(root, candidate);
  return rel !== '' && !rel.startsWith('..') && !rel.includes('/../');
}

async function prepareResourceDrag(
  openUri: string,
  label: string,
): Promise<PreparedResourceDrag> {
  const match = RESOURCE_URI_RE.exec(openUri);
  if (!match) throw new Error(`Unsupported Working Memory resource URI: ${openUri}`);
  const kind = match[1] as DesktopResourceKind;
  const identifier = decodeURIComponent(match[2]);
  const controlPlaneKind =
    kind === 'workstream'
      ? 'Workstream'
      : kind === 'topic'
        ? 'Topic'
        : kind === 'topic-type'
          ? 'TopicType'
          : kind === 'alert'
            ? 'Alert'
            : undefined;
  let result = await controlPlane().getDocument(
    kind === 'document' || kind === 'alert'
      ? { id: identifier }
      : { slug: identifier, ...(controlPlaneKind ? { kind: controlPlaneKind } : {}) },
  );
  if (result.available && !result.document && kind === 'alert') {
    result = await controlPlane().getDocument({ slug: identifier, kind: 'Alert' });
  }
  if (!result.available) {
    throw new Error(result.error ?? 'Working Memory control plane is unavailable.');
  }
  if (!result.document) {
    throw new Error(`Working Memory ${kind} "${identifier}" was not found.`);
  }
  const filename = resourceDragFilename(kind, identifier, label);
  const directory = dragContextDirectory();
  const file = join(directory, filename);
  await mkdir(directory, { recursive: true });
  await writeFile(file, renderDocumentByKind(result.document), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return { filename, filePath: file, fileUrl: pathToFileURL(file).toString() };
}

async function invokeAction(workstream: string, command: string, args: unknown[]): Promise<DocumentVM> {
  const action = resolveDesktopAction(command, args, workstream);
  if (action.kind === 'workstream') {
    await controlPlane().wsUpdate({ slug: action.slug, status: action.section });
  } else if (action.kind === 'topic') {
    if (action.operation === 'attach') await controlPlane().topicAttachWorkstream(action);
    else if (action.operation === 'detach') await controlPlane().topicDetachWorkstream(action);
    else if (action.operation === 'transfer') await controlPlane().topicTransfer(action);
  }
  return loadResource('workstream', workstream);
}

async function requestModel(request: ModelHttpRequest): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Model request timed out after ${Math.round(request.timeoutMs / 1000)} seconds. Check the endpoint, network, and model availability.`);
    }
    throw new Error(`Could not reach the model endpoint. Check the URL and network connection: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as { error?: { message?: unknown }; message?: unknown };
      const candidate = body.error?.message ?? body.message;
      if (typeof candidate === 'string') detail = candidate.slice(0, 300);
    } catch {
      // Status and endpoint mode still provide an actionable error.
    }
    throw new Error(`Model endpoint returned HTTP ${response.status}${detail ? `: ${detail}` : ''}. Check the endpoint, model, and API key.`);
  }
  return response.json();
}

function configuredRequest(config: StoredConfig | StoredModelProfile): { mode: ReturnType<typeof modelEndpoint>['mode']; url: string; headers: Record<string, string> } {
  const endpoint = modelEndpoint(config.endpoint);
  return {
    ...endpoint,
    headers: {
      'content-type': 'application/json',
      ...modelAuthHeaders(endpoint.url, decryptApiKey(config)),
    },
  };
}

async function presentAgentResult(result: DesktopAgentResult, context?: ChatContext): Promise<ChatResult> {
  let document: DocumentVM | undefined;
  const target = result.navigation ?? (result.mutated && context
    ? { kind: context.routeKind, identifier: context.identifier }
    : undefined);
  if (target) {
    try {
      document = await loadResource(target.kind, target.identifier);
    } catch {
      // The tool result remains useful even when a follow-up navigation target disappeared.
    }
  }
  return {
    journalId: result.journalId,
    message: result.message,
    status: result.status,
    mutated: result.mutated,
    progress: result.progress,
    pendingConfirmation: result.pendingConfirmation,
    ...(document ? { document } : {}),
  };
}

async function callConfiguredModel(
  message: string,
  config: StoredConfig,
  context?: ChatContext,
  images: ChatPromptImage[] = [],
): Promise<ChatResult> {
  const profile = resolveModelProfile(config, 'medium', 'complex');
  const request = configuredRequest(profile);
  const environment = environmentManager.currentEnvironment;
  if (images.length && !environment) {
    throw new Error('No healthy Working Memory environment is selected.');
  }
  const mentioned = await resolveMentionedAppTools(message, containerAppDefinitions(), {
    readClaim: currentClaim,
    inspect: (claim) => dockerContainers.inspect(claim),
    connect: async (appId, endpoint) => { await appMcp.connect(appId, endpoint); },
    listTools: (appId, endpoint) => appMcp.listToolsForRoute(appId, endpoint),
  }, context?.containerAppId ? [context.containerAppId] : []);
  const appTools = mentioned.tools.length ? {
    tools: mentioned.tools,
    systemInstructions: appMentionSystemInstructions(mentioned.contexts),
    requiresConfirmation: (name: string) =>
      mentioned.routes.get(name)?.annotations?.readOnlyHint !== true,
    callTool: async (name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> => {
      const route = mentioned.routes.get(name);
      if (!route) return { ok: false, error: `Unknown application tool route: ${name}` };
      try {
        return {
          ok: true,
          result: await appMcp.callTool(route.appId, route.originalToolName, args, route),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  } : undefined;
  return presentAgentResult(await chatAgent.start({
    ...request,
    model: profile.model,
    message,
    context,
    images: await loadPromptImages(
      images,
      environment ? new URL(environment.mcpUrl).origin : '',
      fetch,
      (data) => decodeQrPayloads(nativeImage.createFromBuffer(Buffer.from(data))),
    ),
    ...(appTools ? { appTools } : {}),
  }), context);
}

async function autocompleteTopic(input: TopicAutocompleteInput): Promise<TopicAutocompleteResult> {
  const config = await readStoredConfig(configFile);
  const profile = resolveModelProfile(config, 'fast', 'simple');
  if (!profile.model.trim()) throw new Error('Configure a model for Fast / Simple requests first.');
  const request = configuredRequest(profile);
  const allowedTypes = input.topicTypes
    .filter((type) => type.slug.trim())
    .map((type) => `${type.slug}: ${type.label}${type.description ? ` — ${type.description}` : ''}`)
    .join('\n');
  const prompt =
    'Suggest a concise title and the best topic type for this draft. ' +
    'Return only JSON with string fields "title" and "topicType". ' +
    `The title must be at most 120 characters. Allowed topic types:\n${allowedTypes}\n\n` +
    `Current title: ${input.currentTitle}\nCurrent type: ${input.currentTopicType}\n\nDraft:\n${input.body.slice(0, 12_000)}`;
  const body = request.mode === 'responses'
    ? { model: profile.model, input: prompt }
    : {
        model: profile.model,
        messages: [{ role: 'user', content: prompt }],
      };
  const parsed = parseModelTurn(
    request.mode,
    await requestModel({ ...request, body, timeoutMs: DESKTOP_MODEL_REQUEST_TIMEOUT_MS }),
  );
  let suggestion: unknown;
  try {
    suggestion = JSON.parse(parsed.text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
  } catch {
    throw new Error('Autocomplete model returned invalid JSON.');
  }
  if (!suggestion || typeof suggestion !== 'object') {
    throw new Error('Autocomplete model returned an invalid suggestion.');
  }
  const title = 'title' in suggestion && typeof suggestion.title === 'string'
    ? suggestion.title.trim().slice(0, 120)
    : '';
  const requestedType = 'topicType' in suggestion && typeof suggestion.topicType === 'string'
    ? suggestion.topicType.trim()
    : '';
  const topicType = input.topicTypes.some((type) => type.slug === requestedType)
    ? requestedType
    : input.currentTopicType;
  if (!title) throw new Error('Autocomplete model did not suggest a title.');
  return { title, topicType };
}

function requireContainerAppId(rawId: string): string {
  if (!isContainerAppId(rawId)) throw new Error(`Unsupported container app: ${rawId}`);
  return rawId;
}

function beginContainerOperation(): { client: ControlPlaneClient; signal: AbortSignal; end: () => void } {
  const controller = new AbortController();
  const generation = containerEnvironmentGeneration;
  containerOperations.add(controller);
  return {
    client: controlPlane(),
    signal: controller.signal,
    end: () => {
      containerOperations.delete(controller);
      if (generation !== containerEnvironmentGeneration) controller.abort();
    },
  };
}

async function containerAppClaim(
  client: ControlPlaneClient,
  registration: ContainerAppRegistration,
): Promise<ReturnType<typeof resolveContainerAppClaim>> {
  const [existing] = await client.containerClaimRead({ slug: registration.id });
  return resolveContainerAppClaim(registration, existing);
}

async function currentClaim(id: string): Promise<ContainerClaim | undefined> {
  const [claim] = await controlPlane().containerClaimRead({ slug: id });
  if (!claim) return undefined;
  const desired = resolveContainerAppClaim(containerAppRegistration(id), claim);
  return {
    ...claim,
    ...desired,
    mcp: desired.mcp,
    application: desired.application,
  };
}

async function liveClaim(id: string): Promise<ContainerClaim> {
  const claim = await currentClaim(id);
  if (!claim) throw new Error(`Container App @${id} has no ContainerClaim. Run it first.`);
  return claim;
}

async function ensureConnectedClaim(id: string): Promise<ContainerClaim> {
  const claim = await liveClaim(id);
  if (!claim.mcp) throw new Error(`Container App @${id} does not advertise MCP.`);
  const status = await dockerContainers.inspect(claim);
  if (!status.ready) throw new Error(`Container App @${id} is not healthy (state: ${status.state}).`);
  await appMcp.connect(id, claim.mcp);
  return claim;
}

async function testConfiguredModel(config: StoredConfig): Promise<string> {
  const request = configuredRequest(config);
  const body = request.mode === 'responses'
    ? { model: config.model, input: 'Reply with only: connected' }
    : { model: config.model, messages: [{ role: 'user', content: 'Reply with only: connected' }] };
  const parsed = parseModelTurn(request.mode, await requestModel({ ...request, body, timeoutMs: DESKTOP_MODEL_REQUEST_TIMEOUT_MS }));
  return parsed.text || 'Connected.';
}

function registerIpc(): void {
  ipcMain.on('app:restart', () => {
    if (!existsSync(STABLE_DESKTOP_EXECUTABLE)) {
      dialog.showErrorBox(
        'Working Memory update unavailable',
        'The installed application was not found at /Applications/Working Memory.app.',
      );
      return;
    }
    app.relaunch({ execPath: STABLE_DESKTOP_EXECUTABLE, args: [] });
    app.quit();
  });
  ipcMain.handle('environment:discover', async () => environmentState(await environmentManager.discover()));
  ipcMain.handle('environment:switch', async (_event, mcpUrl: string) => {
    containerEnvironmentGeneration += 1;
    for (const operation of containerOperations) operation.abort();
    await appMcp.disconnectAll();
    await environmentManager.switchTo(mcpUrl, () => chatAgent.reset());
    return environmentState(environmentManager.availableEnvironments);
  });
  ipcMain.handle('backend:health', async () => {
    const environment = environmentManager.currentEnvironment;
    if (!environment) throw new Error('No Working Memory environment is selected.');
    const endpoint = new URL(environment.mcpUrl).origin;
    const observedAt = Date.now();
    try {
      const response = await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5_000) });
      const body = await response.json() as { ok?: boolean; version?: string };
      if (!response.ok || body.ok !== true) {
        throw new Error(`Health check returned HTTP ${response.status}.`);
      }
      return {
        state: 'healthy' as const,
        endpoint,
        result: `Working Memory ${body.version ?? 'unknown version'}`,
        observedAt,
        source: environment.source,
      };
    } catch (error) {
      return {
        state: 'unreachable' as const,
        endpoint,
        result: error instanceof Error ? error.message : String(error),
        observedAt,
        source: environment.source,
      };
    }
  });
  ipcMain.handle('active:get', () => loadActivePanelData(controlPlane()));
  ipcMain.handle('active:reorder', (_event, updates) => persistWorkstreamReorder(controlPlane(), updates));
  ipcMain.handle('config:get', async () => publicConfig(
    credentialMigrationError
      ? { ...(await readStoredConfig(configFile)), encryptedApiKey: undefined }
      : await readStoredConfig(configFile),
    credentialVault?.mode() ?? 'unavailable',
  ));
  ipcMain.handle('config:health', async () => (
    checkConfiguredModel(await readStoredConfig(configFile), testConfiguredModel)
  ));
  ipcMain.handle('config:save', async (_event, input: SaveConfigInput) => publicConfig(
    await saveConfig(input),
    credentialVault?.mode() ?? 'unavailable',
  ));
  ipcMain.handle('config:test', async (_event, input: SaveConfigInput) => {
    try {
      const config = await saveConfig(input);
      return checkConfiguredModel(config, testConfiguredModel);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });
  ipcMain.handle('chat:send', async (
    _event,
    message: string,
    context?: ChatContext,
    images: ChatPromptImage[] = [],
  ) => {
    try {
      const config = await readStoredConfig(configFile);
      if (config.model.trim()) return await callConfiguredModel(message, config, context, images);
      const query = localWorkstreamQuery(message);
      return query
        ? await openWorkstream(query)
        : { message: 'Configure a model in Settings, or ask me to open a workstream.', status: 'failed' };
    } catch (error) {
      return { message: `Unable to complete that request: ${error instanceof Error ? error.message : String(error)}`, status: 'failed' };
    }
  });
  ipcMain.handle('topic:autocomplete', (_event, input: TopicAutocompleteInput) =>
    autocompleteTopic(input));
  ipcMain.handle('chat:confirm', async (_event, id: string, confirmed: boolean, context?: ChatContext) => {
    try {
      return await presentAgentResult(await chatAgent.resolveConfirmation(id, confirmed), context);
    } catch (error) {
      return { message: `Unable to resolve that action: ${error instanceof Error ? error.message : String(error)}`, status: 'failed' };
    }
  });
  ipcMain.handle('chat:history', (_event, input: CommandJournalHistoryInput = {}) =>
    controlPlane().commandJournalRead(input));
  ipcMain.handle('chat:journal', (_event, id: string) => {
    if (!id.trim()) throw new Error('A command journal id is required.');
    return controlPlane().commandJournalRead({ id });
  });
  ipcMain.handle('workstream:open', async (_event, query: string) => {
    try {
      return await openWorkstream(query);
    } catch (error) {
      return { message: `Control plane disconnected: ${error instanceof Error ? error.message : String(error)}`, status: 'failed' };
    }
  });
  ipcMain.handle('resource:open', (_event, kind: DesktopResourceKind, identifier: string) => {
    if (!['workstream', 'topic', 'document', 'alert', 'topic-type'].includes(kind)) {
      throw new Error(`Unsupported Working Memory resource kind: ${String(kind)}`);
    }
    return loadResource(kind, identifier);
  });
  ipcMain.handle('resource:prepare-drag', (_event, openUri: string, label: string) =>
    prepareResourceDrag(openUri, label));
  ipcMain.on('resource:start-drag', (event, prepared: PreparedResourceDrag) => {
    try {
      if (!prepared || !isDragContextFile(prepared.filePath)) {
        throw new Error('Refusing native drag outside the context directory');
      }
      const icon = createDragIcon();
      if (icon.isEmpty()) {
        throw new Error('Unable to create the native drag icon');
      }
      event.sender.startDrag({ file: prepared.filePath, icon });
      event.reply('resource:drag-result', {
        filePath: prepared.filePath,
        status: 'started',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[desktop] Unable to start native Working Memory drag:', error);
      event.reply('resource:drag-result', {
        filePath: prepared?.filePath ?? '',
        status: 'failed',
        error: message,
      });
    }
  });
  ipcMain.handle('workstream:save', async (_event, identifier: string, patch: { title?: string; status?: string }) => {
    const current = await loadWorkstreamViewModel(controlPlane(), identifier);
    if (!current?.slug) throw new Error('This workstream cannot be edited.');
    await controlPlane().wsUpdate({ slug: current.slug, ...patch });
    return loadResource('workstream', current.slug);
  });
  ipcMain.handle('topic:save', async (_event, identifier: string, patch: TopicPatch) => {
    const current = await loadTopicViewModel(controlPlane(), identifier);
    if (!current?.slug) throw new Error('This topic cannot be edited.');
    await controlPlane().topicUpdate({ slug: current.slug, ...patch });
    return loadResource('topic', current.slug);
  });
  ipcMain.handle('topic:list-types', async () => (await controlPlane().topicTypeRead())
    .filter((topicType) => topicType.slug)
    .map((topicType) => ({
      slug: topicType.slug,
      label: topicType.label,
      icon: topicType.icon,
      description: topicType.description,
    })));
  ipcMain.handle('topic:create', async (_event, input: {
    title: string;
    body: string;
    topicType: string;
    workstream: string;
    parent?: string;
  }) => {
    const title = input.title.trim();
    const topicType = input.topicType.trim();
    const workstream = input.workstream.trim();
    if (!title) throw new Error('A topic title is required.');
    if (!topicType) throw new Error('A topic type is required.');
    if (!workstream) throw new Error('A workstream is required.');
    const created = await controlPlane().topicCreate({
      title,
      body: input.body,
      topicType,
      parents: input.parent ? [input.parent] : [],
      workstreams: [workstream],
    });
    return loadResource('topic', created.slug ?? created.id);
  });
  ipcMain.handle('topic:reparent', async (_event, slug: string, parent: string | null) => {
    await controlPlane().topicUpdate({ slug, parents: parent ? [parent] : [] });
  });
  ipcMain.handle('attachment:upload', async (_event, file: {
    name: string;
    type: string;
    data: ArrayBuffer;
  }) => {
    const environment = environmentManager.currentEnvironment;
    if (!environment) throw new Error('No healthy Working Memory environment is selected.');
    const baseUrl = new URL(environment.mcpUrl).origin;
    const response = await fetch(`${baseUrl}/attachments`, {
      method: 'POST',
      headers: {
        'content-type': file.type,
        'x-file-name': encodeURIComponent(file.name),
      },
      body: Buffer.from(file.data),
    });
    const payload = await response.json() as {
      id?: string;
      filename?: string;
      mimeType?: string;
      error?: string;
    };
    if (!response.ok || !payload.id || !payload.filename || !payload.mimeType) {
      throw new Error(payload.error ?? `Attachment upload failed (${response.status}).`);
    }
    return { id: payload.id, filename: payload.filename, mimeType: payload.mimeType };
  });
  ipcMain.handle('topic:toggle-pin', async (_event, workstream: string, topic: string) => {
    const [current] = await controlPlane().topicRead({ slug: topic });
    if (!current?.slug) throw new Error(`Topic "${topic}" was not found.`);
    if (current.focusedWorkstreams.includes(workstream)) {
      await controlPlane().topicClearFocus({ slug: current.slug, workstream });
    } else {
      await controlPlane().topicSetFocus({ slug: current.slug, workstream });
    }
    return loadResource('workstream', workstream);
  });
  ipcMain.handle('alert:set-status', async (_event, context, id, status) => {
    await controlPlane().alertUpdate({ id, status });
    return loadResource(context.kind, context.identifier);
  });
  ipcMain.handle('action:invoke', (_event, workstream, command, args) => invokeAction(workstream, command, args));
  ipcMain.handle('container:list', () => containerAppDefinitions());
  ipcMain.handle('container:run', async (_event, rawId: string) => {
    const registration = containerAppRegistration(requireContainerAppId(rawId));
    const scope = beginContainerOperation();
    try {
      return await dockerContainers.ensure(
        scope.client,
        await containerAppClaim(scope.client, registration),
        scope.signal,
      );
    } finally {
      scope.end();
    }
  });
  ipcMain.handle('container:inspect', async (_event, rawId: string) => {
    const registration = containerAppRegistration(requireContainerAppId(rawId));
    const scope = beginContainerOperation();
    try {
      return await dockerContainers.inspect(
        await containerAppClaim(scope.client, registration),
        scope.signal,
      );
    } finally {
      scope.end();
    }
  });
  ipcMain.handle('container:stop', async (_event, rawId: string) => {
    const id = requireContainerAppId(rawId);
    const registration = containerAppRegistration(id);
    const scope = beginContainerOperation();
    try {
      const result = await dockerContainers.stop(
        await containerAppClaim(scope.client, registration),
        scope.signal,
      );
      await appMcp.disconnect(id).catch(() => undefined);
      return result;
    } finally {
      scope.end();
    }
  });
  ipcMain.handle('container:open', async (_event, rawId: string) => {
    const id = requireContainerAppId(rawId);
    const registration = containerAppRegistration(id);
    const scope = beginContainerOperation();
    try {
      const status = await dockerContainers.inspect(
        await containerAppClaim(scope.client, registration),
        scope.signal,
      );
      if (!status.ready) throw new Error(`${registration.displayName} is not healthy.`);
      const url = new URL(status.url);
      if (url.protocol !== 'http:' || url.hostname !== 'localhost') {
        throw new Error('Container app URLs must use localhost HTTP.');
      }
      await shell.openExternal(url.toString());
      return status;
    } finally {
      scope.end();
    }
  });
  ipcMain.handle('app-mcp:status', async (_event, rawId: string) => {
    const id = requireContainerAppId(rawId);
    const claim = await liveClaim(id).catch(() => undefined);
    return appMcp.status(id, claim?.mcp);
  });
  ipcMain.handle('app-mcp:connect', async (_event, rawId: string) => {
    const id = requireContainerAppId(rawId);
    const claim = await ensureConnectedClaim(id);
    return appMcp.status(id, claim.mcp);
  });
  ipcMain.handle('app-mcp:disconnect', (_event, rawId: string) =>
    appMcp.disconnect(requireContainerAppId(rawId)));
  ipcMain.handle('app-mcp:list-tools', async (_event, rawId: string) => {
    const id = requireContainerAppId(rawId);
    await ensureConnectedClaim(id);
    return appMcp.listTools(id);
  });
  ipcMain.handle('app-mcp:call-tool', async (
    _event,
    rawId: string,
    name: string,
    args: Record<string, unknown>,
  ) => {
    const id = requireContainerAppId(rawId);
    await ensureConnectedClaim(id);
    return appMcp.callTool(id, name, args);
  });
  ipcMain.handle('app-mcp:contract', async (_event, rawId: string) => {
    const id = requireContainerAppId(rawId);
    const claim = await ensureConnectedClaim(id);
    if (!claim.application) throw new Error(`Container App @${id} has no application contract metadata.`);
    const result = await appMcp.callTool(id, claim.application.discovery.toolName, {});
    const contract = parseAppResourceContract(result);
    if (contract.application.id !== claim.application.id) {
      throw new Error(
        `Application contract identity mismatch: expected "${claim.application.id}", received "${contract.application.id}".`,
      );
    }
    return contract;
  });
  ipcMain.handle('external:open', async (_event, rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS links can be opened externally.');
    }
    await shell.openExternal(url.toString());
  });
}

function currentWindowBounds(window: BrowserWindow) {
  return window.getNormalBounds();
}

function saveWindowState(window: BrowserWindow, immediately = false): void {
  if (!windowStateFile || window.isDestroyed()) return;
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  const bounds = currentWindowBounds(window);
  if (immediately) {
    windowStateSaveTimer = undefined;
    try {
      writeWindowBoundsSync(windowStateFile, bounds);
    } catch (error) {
      console.warn('Unable to save desktop window state:', error);
    }
    return;
  }
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = undefined;
    void writeWindowBounds(windowStateFile, bounds).catch((error) => {
      console.warn('Unable to save desktop window state:', error);
    });
  }, WINDOW_STATE_SAVE_DELAY_MS);
}

async function createWindow(): Promise<BrowserWindow> {
  const primaryDisplayId = screen.getPrimaryDisplay().id;
  const displays = screen.getAllDisplays().map((display) => ({
    workArea: display.workArea,
    primary: display.id === primaryDisplayId,
  }));
  const savedBounds = await readWindowBounds(windowStateFile);
  const bounds = resolveWindowBounds(savedBounds, displays, WINDOW_DEFAULTS);
  const window = new BrowserWindow({
    ...(bounds ?? { width: WINDOW_DEFAULTS.defaultWidth, height: WINDOW_DEFAULTS.defaultHeight }),
    minWidth: WINDOW_DEFAULTS.minWidth,
    minHeight: WINDOW_DEFAULTS.minHeight,
    title: 'Working Memory',
    backgroundColor: '#f3f1ea',
    webPreferences: {
      preload: join(bundleDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  window.on('move', () => saveWindowState(window));
  window.on('resize', () => saveWindowState(window));
  window.on('close', () => saveWindowState(window, true));
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(bundleDirectory, '../renderer/index.html'));
  }
  return window;
}

function ensureWindow(): Promise<BrowserWindow> {
  if (mainWindow && !mainWindow.isDestroyed()) return Promise.resolve(mainWindow);
  if (mainWindowCreation) return mainWindowCreation;
  mainWindowCreation = createWindow().finally(() => {
    mainWindowCreation = null;
  });
  return mainWindowCreation;
}

function focusWindow(window: BrowserWindow): void {
  if (window.isMinimized()) window.restore();
  window.show();
  if (process.platform === 'darwin') app.focus({ steal: true });
  window.focus();
}

function sendDeepLink(window: BrowserWindow, target: DesktopDeepLinkTarget): void {
  window.webContents.send('resource:open-deep-link', target.kind, target.identifier);
}

async function activateDesktopWindow(): Promise<void> {
  const window = await ensureWindow();
  focusWindow(window);
}

async function openDeepLink(target: DesktopDeepLinkTarget): Promise<void> {
  pendingDeepLink = target;
  if (!app.isReady()) return;
  const window = await ensureWindow();
  focusWindow(window);
  await new Promise<void>((resolve) => {
    const deliver = (): void => {
      const current = pendingDeepLink;
      pendingDeepLink = null;
      if (current) sendDeepLink(window, current);
      resolve();
    };
    if (window.webContents.isLoadingMainFrame()) {
      window.webContents.once('did-finish-load', deliver);
    } else {
      deliver();
    }
  });
}

function deepLinkFromArgs(argv: string[]): DesktopDeepLinkTarget | null {
  for (const arg of argv) {
    const target = parseDesktopDeepLink(arg);
    if (target) return target;
  }
  return null;
}

function registerDesktopProtocol(): void {
  const registered = process.defaultApp && process.argv[1]
    ? app.setAsDefaultProtocolClient(
        WORKING_MEMORY_PROTOCOL,
        process.execPath,
        [resolve(process.argv[1])],
      )
    : app.setAsDefaultProtocolClient(WORKING_MEMORY_PROTOCOL);
  if (!registered) {
    console.error(`[desktop] Unable to register ${WORKING_MEMORY_PROTOCOL}:// links`);
  }
}

const ownsSingleInstanceLock = app.requestSingleInstanceLock({ refreshDesktop: true });

if (!ownsSingleInstanceLock) {
  app.exit(0);
} else {
  app.on('open-url', (event, rawUrl) => {
    event.preventDefault();
    const target = parseDesktopDeepLink(rawUrl);
    if (target) void openDeepLink(target).catch((error) => {
      console.error('[desktop] Unable to open protocol link:', error);
    });
  });

  app.on('second-instance', (_event, argv) => {
    const target = deepLinkFromArgs(argv);
    if (target) {
      void openDeepLink(target).catch((error) => {
        console.error('[desktop] Unable to open second-instance link:', error);
      });
      return;
    }
    const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (existingWindow) {
      focusWindow(existingWindow);
    } else if (app.isReady()) {
      void ensureWindow().then(focusWindow);
    }
  });

  void app.whenReady().then(async () => {
    registerDesktopProtocol();
    configFile = join(app.getPath('userData'), 'config.json');
    credentialVault = new DesktopCredentialVault(
      safeStorage,
      process.platform,
      join(app.getPath('userData'), 'credential-vault.key'),
    );
    try {
      const storedConfig = await readStoredConfig(configFile);
      const migratedConfig = credentialVault.migrate(storedConfig);
      if (migratedConfig !== storedConfig) {
        await writeStoredConfig(configFile, migratedConfig);
      }
    } catch (error) {
      credentialMigrationError = `The existing API key could not be migrated. Re-enter it in Settings. ${
        error instanceof Error ? error.message : String(error)
      }`;
      console.error('[desktop] Credential migration failed:', error);
    }
    environmentFile = join(app.getPath('userData'), 'environment.json');
    windowStateFile = join(app.getPath('userData'), 'window-state.json');
    await environmentManager.initialize();
    desktopLinkBridge = new DesktopLinkBridge(
      openDeepLink,
      undefined,
      activateDesktopWindow,
    );
    try {
      await desktopLinkBridge.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[desktop] Unable to start Agent Window link bridge:', error);
      dialog.showErrorBox(
        'Working Memory link bridge unavailable',
        `Links from the VS Code Agents window will not open: ${message}`,
      );
    }
    registerIpc();
    await ensureWindow();
    const initialDeepLink = deepLinkFromArgs(process.argv);
    if (initialDeepLink) {
      void openDeepLink(initialDeepLink).catch((error) => {
        console.error('[desktop] Unable to open initial link:', error);
      });
    }
    app.on('activate', () => {
      const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0];
      if (existingWindow) focusWindow(existingWindow);
      else void ensureWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (event) => {
    if (mainWindow) saveWindowState(mainWindow, true);
    void gracefulShutdown(event);
  });
}