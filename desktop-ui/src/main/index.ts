import { app, BrowserWindow, ipcMain, safeStorage, screen, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlaneClient } from '../../../src/controlPlaneClient';
import type {
  ChatContext,
  ChatResult,
  DesktopEnvironmentState,
  DesktopResourceKind,
  SaveConfigInput,
} from '../shared/contracts';
import type { CommandJournalHistoryInput } from '../../../src/controlPlaneClient';
import type { DocumentVM, TopicPatch } from '../../../webview-ui/src/lib/types';
import {
  modelAuthHeaders,
  modelEndpoint,
  publicConfig,
  readStoredConfig,
  writeStoredConfig,
  type StoredConfig,
} from './config';
import { DesktopChatAgent, type DesktopAgentResult, type ModelHttpRequest } from './desktopChatAgent';
import {
  DesktopEnvironmentManager,
  readPersistedEnvironment,
  writePersistedEnvironment,
} from './environments';
import { parseModelTurn } from './modelTools';
import {
  readWindowBounds,
  resolveWindowBounds,
  writeWindowBounds,
  writeWindowBoundsSync,
} from './windowState';
import {
  chooseWorkstream,
  loadActivePanelData,
  loadTopicViewModel,
  loadWorkstreamViewModel,
  localWorkstreamQuery,
  resolveDesktopAction,
  toGenericDocumentViewModel,
} from './resolver';

const bundleDirectory = dirname(fileURLToPath(import.meta.url));
const MODEL_TIMEOUT_MS = 20_000;
const WINDOW_DEFAULTS = { defaultWidth: 1280, defaultHeight: 820, minWidth: 900, minHeight: 600 };
const WINDOW_STATE_SAVE_DELAY_MS = 250;
let configFile = '';
let environmentFile = '';
let windowStateFile = '';
let mainWindow: BrowserWindow | null = null;
let mainWindowCreation: Promise<BrowserWindow> | null = null;
let windowStateSaveTimer: ReturnType<typeof setTimeout> | undefined;

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

function decryptApiKey(config: StoredConfig): string {
  if (!config.encryptedApiKey) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure credential storage is unavailable on this system');
  }
  return safeStorage.decryptString(Buffer.from(config.encryptedApiKey, 'base64'));
}

async function saveConfig(input: SaveConfigInput): Promise<StoredConfig> {
  const current = await readStoredConfig(configFile);
  const next: StoredConfig = {
    endpoint: input.endpoint,
    model: input.model,
    ...(current.encryptedApiKey ? { encryptedApiKey: current.encryptedApiKey } : {}),
  };
  if (input.apiKey?.trim()) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('Secure credential storage is unavailable on this system');
    }
    next.encryptedApiKey = safeStorage.encryptString(input.apiKey.trim()).toString('base64');
  }
  await writeStoredConfig(configFile, next);
  return next;
}

async function openWorkstream(query: string): Promise<ChatResult> {
  const workstreams = await controlPlane().wsRead({ limit: 200 });
  const workstream = chooseWorkstream(query, workstreams);
  if (!workstream) {
    return { message: `I couldn't find a workstream matching “${query}”.` };
  }
  return {
    message: `Opened ${workstream.title}.`,
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
    else await controlPlane().topicDetachWorkstream(action);
  } else if (action.operation === 'run') {
    await controlPlane().naniteRun({ id: action.id, approved: true });
  } else if (action.operation === 'reset') {
    await controlPlane().naniteRun({ id: action.id, reset: true });
  } else {
    await controlPlane().naniteRun({ id: action.id, reset: true });
    await controlPlane().naniteRun({ id: action.id, approved: true });
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
  const parsed = parseModelTurn(request.mode, await requestModel({ ...request, body, timeoutMs: MODEL_TIMEOUT_MS }));
  return parsed.text || 'Connected.';
}

function registerIpc(): void {
  ipcMain.handle('environment:discover', async () => environmentState(await environmentManager.discover()));
  ipcMain.handle('environment:switch', async (_event, mcpUrl: string) => {
    await environmentManager.switchTo(mcpUrl, () => chatAgent.reset());
    return environmentState(environmentManager.availableEnvironments);
  });
  ipcMain.handle('active:get', () => loadActivePanelData(controlPlane()));
  ipcMain.handle('config:get', async () => publicConfig(await readStoredConfig(configFile)));
  ipcMain.handle('config:save', async (_event, input: SaveConfigInput) => publicConfig(await saveConfig(input)));
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
        : { message: 'Configure a model in Settings, or ask me to open a workstream.' };
    } catch (error) {
      return { message: `Unable to complete that request: ${error instanceof Error ? error.message : String(error)}` };
    }
  });
  ipcMain.handle('chat:confirm', async (_event, id: string, confirmed: boolean, context?: ChatContext) => {
    try {
      return await presentAgentResult(await chatAgent.resolveConfirmation(id, confirmed), context);
    } catch (error) {
      return { message: `Unable to resolve that action: ${error instanceof Error ? error.message : String(error)}` };
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
      return { message: `Control plane disconnected: ${error instanceof Error ? error.message : String(error)}` };
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

  app.on('before-quit', () => {
    if (mainWindow) saveWindowState(mainWindow, true);
    void environmentManager.dispose();
  });
}