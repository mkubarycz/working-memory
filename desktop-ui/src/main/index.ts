import { app, BrowserWindow, ipcMain, safeStorage, screen, shell } from 'electron';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlaneClient } from '../../../src/controlPlaneClient';
import type {
  ChatContext,
  ChatResult,
  ContainerAppId,
  ContainerAppStatus,
  DesktopEnvironmentState,
  DesktopResourceKind,
  PublicConfig,
  SaveConfigInput,
} from '../shared/contracts';
import type { CommandJournalHistoryInput, ContainerClaim } from '../../../src/controlPlaneClient';
import type { DocumentVM, TopicPatch } from '../../../webview-ui/src/lib/types';
import {
  CredentialManager,
  modelAuthHeaders,
  modelEndpoint,
  publicConfig,
  readStoredConfig,
  writeStoredConfig,
  type StoredConfig,
} from './config';
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
import { createGracefulShutdown } from './gracefulShutdown';
import {
  DockerContainerService,
  resolveClarinetHeroClaim,
  type ContainerLaunchResult,
} from './dockerContainerService';
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

const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const WINDOW_DEFAULTS = { defaultWidth: 1280, defaultHeight: 820, minWidth: 900, minHeight: 600 };
const WINDOW_STATE_SAVE_DELAY_MS = 250;
let configFile = '';
let environmentFile = '';
let windowStateFile = '';
let mainWindow: BrowserWindow | null = null;
let mainWindowCreation: Promise<BrowserWindow> | null = null;
let windowStateSaveTimer: ReturnType<typeof setTimeout> | undefined;
const dockerContainerService = new DockerContainerService();
let containerEnvironmentGeneration = 0;
const containerOperations = new Set<AbortController>();
const containerLaunches = new Map<string, Promise<ContainerLaunchResult>>();
const SUPPORTED_CONTAINER_APP_IDS = new Set<ContainerAppId>(['clarinet-hero']);

const environmentManager = new DesktopEnvironmentManager<ControlPlaneClient>({
  createClient: (mcpUrl) => new ControlPlaneClient({ resolveUrl: () => mcpUrl }),
  readPersistedSelection: () => readPersistedEnvironment(environmentFile),
  writePersistedSelection: (mcpUrl) => writePersistedEnvironment(environmentFile, mcpUrl),
});

function controlPlane(): ControlPlaneClient {
  return environmentManager.currentClient;
}

interface ContainerOperationScope {
  client: ControlPlaneClient;
  generation: number;
  controller: AbortController;
}

function requireContainerAppId(id: string): ContainerAppId {
  if (!SUPPORTED_CONTAINER_APP_IDS.has(id as ContainerAppId)) {
    throw new Error(`Unsupported container app: ${id}`);
  }
  return id as ContainerAppId;
}

function beginContainerOperation(): ContainerOperationScope {
  const controller = new AbortController();
  containerOperations.add(controller);
  return { client: controlPlane(), generation: containerEnvironmentGeneration, controller };
}

function finishContainerOperation(scope: ContainerOperationScope): void {
  containerOperations.delete(scope.controller);
}

function assertCurrentContainerEnvironment(scope: ContainerOperationScope): void {
  if (scope.generation !== containerEnvironmentGeneration || scope.client !== controlPlane()) {
    throw new Error('Container operation cancelled because the control-plane environment changed.');
  }
}

async function ensureClarinetHero(scope: ContainerOperationScope): Promise<ContainerLaunchResult> {
  const desired = await clarinetHeroClaim(scope.client);
  assertCurrentContainerEnvironment(scope);
  if ('code' in desired) return desired;
  const result = await dockerContainerService.ensure(scope.client, desired, scope.controller.signal);
  assertCurrentContainerEnvironment(scope);
  return result;
}

async function clarinetHeroClaim(client: ControlPlaneClient): Promise<ReturnType<typeof resolveClarinetHeroClaim> | Extract<ContainerLaunchResult, { status: 'error' }>> {
  let existing: ContainerClaim | undefined;
  try {
    [existing] = await client.containerClaimRead({ slug: 'clarinet-hero' });
  } catch (error) {
    return {
      status: 'error',
      code: 'claim_error',
      message: `Unable to read the Clarinet Hero ContainerClaim. ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  try {
    const claim = resolveClarinetHeroClaim(existing, {
      searchRoots: [resolve(app.getAppPath(), '..', '..', 'ClarinetHero')],
    });
    return claim;
  } catch (error) {
    return {
      status: 'error',
      code: 'source_not_found',
      message: error instanceof Error ? error.message : String(error),
    };
  }
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
  resetAgent: () => chatAgent.reset(),
  disposeEnvironment: () => environmentManager.dispose(),
  quit: () => app.quit(),
  onError: (error) => console.error('[desktop] graceful shutdown failed:', error),
});

const credentialManager = new CredentialManager(safeStorage, (message) => {
  console.warn(`[desktop] ${message}`);
});

function desktopPublicConfig(config: StoredConfig): PublicConfig {
  return {
    ...publicConfig(config),
    hasApiKey: credentialManager.hasApiKey(config),
    credentialStorage: credentialManager.mode(),
  };
}

async function saveConfig(input: SaveConfigInput): Promise<StoredConfig> {
  const current = await readStoredConfig(configFile);
  const next: StoredConfig = {
    endpoint: input.endpoint,
    model: input.model,
    ...(current.encryptedApiKey ? { encryptedApiKey: current.encryptedApiKey } : {}),
  };
  const stored = credentialManager.store(next, input.apiKey);
  await writeStoredConfig(configFile, stored);
  return stored;
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

function configuredRequest(config: StoredConfig): { mode: ReturnType<typeof modelEndpoint>['mode']; url: string; headers: Record<string, string> } {
  const endpoint = modelEndpoint(config.endpoint);
  return {
    ...endpoint,
    headers: {
      'content-type': 'application/json',
      ...modelAuthHeaders(endpoint.url, credentialManager.read(config)),
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

async function callConfiguredModel(message: string, config: StoredConfig, context?: ChatContext): Promise<ChatResult> {
  const request = configuredRequest(config);
  return presentAgentResult(await chatAgent.start({ ...request, model: config.model, message, context }), context);
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
  ipcMain.handle('environment:discover', async () => environmentState(await environmentManager.discover()));
  ipcMain.handle('environment:switch', async (_event, mcpUrl: string) => {
    containerEnvironmentGeneration += 1;
    for (const operation of containerOperations) operation.abort();
    containerLaunches.clear();
    await environmentManager.switchTo(mcpUrl, () => chatAgent.reset());
    return environmentState(environmentManager.availableEnvironments);
  });
  ipcMain.handle('active:get', () => loadActivePanelData(controlPlane()));
  ipcMain.handle('active:reorder', (_event, updates) => persistWorkstreamReorder(controlPlane(), updates));
  ipcMain.handle('config:get', async () => desktopPublicConfig(await readStoredConfig(configFile)));
  ipcMain.handle('config:save', async (_event, input: SaveConfigInput) => desktopPublicConfig(await saveConfig(input)));
  ipcMain.handle('config:test', async (_event, input: SaveConfigInput) => {
    try {
      const config = await saveConfig(input);
      if (!config.model.trim()) return { ok: false, message: 'Choose a model first.' };
      return { ok: true, message: await testConfiguredModel(config) };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle('chat:send', async (_event, message: string, context?: ChatContext) => {
    try {
      const config = await readStoredConfig(configFile);
      if (config.model.trim()) return await callConfiguredModel(message, config, context);
      const query = localWorkstreamQuery(message);
      return query
        ? await openWorkstream(query)
        : { message: 'Configure a model in Settings, or ask me to open a workstream.', status: 'failed' };
    } catch (error) {
      return { message: `Unable to complete that request: ${error instanceof Error ? error.message : String(error)}`, status: 'failed' };
    }
  });
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
  ipcMain.handle('container:run', async (_event, rawId: string) => {
    const id = requireContainerAppId(rawId);
    const scope = beginContainerOperation();
    const key = `${scope.generation}:${id}`;
    let launch = containerLaunches.get(key);
    if (!launch) {
      launch = ensureClarinetHero(scope).finally(() => {
        containerLaunches.delete(key);
        finishContainerOperation(scope);
      });
      containerLaunches.set(key, launch);
    } else {
      finishContainerOperation(scope);
    }
    return launch;
  });
  ipcMain.handle('container:inspect', async (_event, rawId: string): Promise<ContainerAppStatus> => {
    requireContainerAppId(rawId);
    const scope = beginContainerOperation();
    try {
      const desired = await clarinetHeroClaim(scope.client);
      assertCurrentContainerEnvironment(scope);
      if ('code' in desired) return failedAppStatus(desired.message);
      const status = await dockerContainerService.inspect(desired, scope.controller.signal);
      assertCurrentContainerEnvironment(scope);
      return status;
    } finally {
      finishContainerOperation(scope);
    }
  });
  ipcMain.handle('container:stop', async (_event, rawId: string) => {
    requireContainerAppId(rawId);
    const scope = beginContainerOperation();
    try {
      const desired = await clarinetHeroClaim(scope.client);
      assertCurrentContainerEnvironment(scope);
      if ('code' in desired) return { status: 'error', message: desired.message, detail: failedAppStatus(desired.message) };
      const result = await dockerContainerService.stop(desired, scope.controller.signal);
      assertCurrentContainerEnvironment(scope);
      return result;
    } finally {
      finishContainerOperation(scope);
    }
  });
  ipcMain.handle('container:open', async (_event, rawId: string): Promise<ContainerAppStatus> => {
    requireContainerAppId(rawId);
    const scope = beginContainerOperation();
    try {
      const desired = await clarinetHeroClaim(scope.client);
      assertCurrentContainerEnvironment(scope);
      if ('code' in desired) return failedAppStatus(desired.message);
      const status = await dockerContainerService.inspect(desired, scope.controller.signal);
      assertCurrentContainerEnvironment(scope);
    if (!status.ready || status.state !== 'healthy') {
      return { ...status, lastAction: 'Open refused', error: status.error ?? 'Claranet Hero must be running and healthy before it can be opened.' };
    }
    const url = new URL(status.url);
    if (url.protocol !== 'http:' || url.hostname !== 'localhost' || url.port !== '4173') {
      return { ...status, lastAction: 'Open refused', error: 'Refusing to open an unexpected container URL.' };
    }
    await shell.openExternal(url.toString());
    return { ...status, lastAction: 'Opened app', error: null };
    } finally {
      finishContainerOperation(scope);
    }
  });
  ipcMain.handle('external:open', async (_event, rawUrl: string) => {
    const url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('Only HTTP and HTTPS links can be opened externally.');
    }

    await shell.openExternal(url.toString());
  });
}

function failedAppStatus(message: string): ContainerAppStatus {
  return {
    id: 'clarinet-hero',
    displayName: 'Claranet Hero',
    claimTitle: 'Clarinet Hero',
    claimSlug: 'clarinet-hero',
    repository: '',
    buildContext: '',
    dockerfile: '',
    image: 'clarinet-hero:local',
    containerName: 'working-memory-clarinet-hero',
    dockerContext: null,
    state: 'error',
    hostPort: 4173,
    containerPort: 80,
    url: 'http://localhost:4173/',
    ready: false,
    lastAction: 'Status failed',
    error: message,
  };
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

function focusWindow(window: BrowserWindow, reload: boolean): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (reload) window.webContents.reloadIgnoringCache();
}

const ownsSingleInstanceLock = app.requestSingleInstanceLock({ refreshDesktop: true });

if (!ownsSingleInstanceLock) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0];
    if (existingWindow) {
      focusWindow(existingWindow, true);
    } else if (app.isReady()) {
      void ensureWindow().then((window) => focusWindow(window, false));
    }
  });

  void app.whenReady().then(async () => {
    configFile = join(app.getPath('userData'), 'config.json');
    environmentFile = join(app.getPath('userData'), 'environment.json');
    windowStateFile = join(app.getPath('userData'), 'window-state.json');
    await environmentManager.initialize();
    registerIpc();
    await ensureWindow();
    app.on('activate', () => {
      const existingWindow = mainWindow ?? BrowserWindow.getAllWindows()[0];
      if (existingWindow) focusWindow(existingWindow, false);
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