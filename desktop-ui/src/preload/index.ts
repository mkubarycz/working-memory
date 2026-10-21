import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, SaveConfigInput } from '../shared/contracts';
import { toIpcPayload } from './ipcPayload';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args.map(toIpcPayload)) as Promise<T>;
}

const api: DesktopApi = {
  prepareFeedback: (slug, requestId) => invoke('feedback:prepare', slug, requestId),
  sendFeedback: (slug, requestId, serverId) => invoke('feedback:send', slug, requestId, serverId),
  startDocumentChanges: () => invoke('documents:watch'),
  onDocumentChanges: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, event: Parameters<typeof listener>[0]) => listener(event);
    ipcRenderer.on('documents:changed', handler);
    return () => ipcRenderer.removeListener('documents:changed', handler);
  },
  listContainerApps: () => invoke('container:list'),
  discoverEnvironments: () => invoke('environment:discover'),
  switchEnvironment: (mcpUrl) => invoke('environment:switch', mcpUrl),
  listInstances: () => invoke('instances:list'),
  createInstance: (name) => invoke('instances:create', name),
  startInstance: (port) => invoke('instances:start', port),
  stopInstance: (port) => invoke('instances:stop', port),
  upgradeInstance: (port) => invoke('instances:upgrade', port),
  setBackendUpdateChannel: (channel) => invoke('instances:set-channel', channel),
  getDesktopUpdate: () => invoke('updates:get'),
  setDesktopUpdateChannel: (channel) => invoke('updates:set-channel', channel),
  checkDesktopUpdate: () => invoke('updates:check'),
  downloadDesktopUpdate: () => invoke('updates:download'),
  installDesktopUpdate: () => invoke('updates:install'),
  onDesktopUpdate: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state);
    ipcRenderer.on('updates:state', handler);
    return () => ipcRenderer.removeListener('updates:state', handler);
  },
  renameInstance: (port, name) => invoke('instances:rename', port, name),
  backupInstance: (port) => invoke('instances:backup', port),
  getActivePanel: () => invoke('active:get'),
  reorderWorkstreams: (updates) => invoke('active:reorder', updates),
  getConfig: () => invoke('config:get'),
  getBackendHealth: () => invoke('backend:health'),
  getOpenAiHealth: () => invoke('config:health'),
  saveConfig: (input: SaveConfigInput) => invoke('config:save', input),
  testConnection: (input: SaveConfigInput) => invoke('config:test', input),
  testModelProfile: (input) => invoke('config:test-profile', input),
  listCopilotModels: () => invoke('config:copilot-models'),
  sendChat: (message, context, images) => invoke('chat:send', message, context, images),
  autocompleteTopic: (input) => invoke('topic:autocomplete', input),
  resolveChatConfirmation: (id, confirmed, context) => invoke('chat:confirm', id, confirmed, context),
  getChatHistory: (input = {}) => invoke('chat:history', input),
  getChatJournal: (id) => invoke('chat:journal', id),
  openWorkstream: (query: string) => invoke('workstream:open', query),
  openResource: (kind, identifier) => invoke('resource:open', kind, identifier),
  onOpenResource: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      kind: Parameters<typeof listener>[0],
      identifier: string,
    ) => listener(kind, identifier);
    ipcRenderer.on('resource:open-deep-link', handler);
    return () => ipcRenderer.removeListener('resource:open-deep-link', handler);
  },
  prepareResourceDrag: (openUri, label) => invoke('resource:prepare-drag', openUri, label),
  startResourceDrag: (prepared) => ipcRenderer.send('resource:start-drag', toIpcPayload(prepared)),
  onResourceDragResult: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      result: Parameters<typeof listener>[0],
    ) => listener(result);
    ipcRenderer.on('resource:drag-result', handler);
    return () => ipcRenderer.removeListener('resource:drag-result', handler);
  },
  saveWorkstream: (identifier, patch) => invoke('workstream:save', identifier, patch),
  saveTopic: (identifier, patch) => invoke('topic:save', identifier, patch),
  listTopicTypes: () => invoke('topic:list-types'),
  createWorkstream: (title) => invoke('workstream:create', title),
  createTopic: (input) => invoke('topic:create', input),
  reparentTopic: (slug, parent) => invoke('topic:reparent', slug, parent),
  uploadAttachment: (file) => invoke('attachment:upload', file),
  togglePin: (workstream, topic) => invoke('topic:toggle-pin', workstream, topic),
  getAgentMessages: () => invoke('agent-message:list'),
  recordAgentMessageDecision: (id, decision) => invoke('agent-message:record-decision', id, decision),
  setAgentMessageStatus: (id, status) => invoke('agent-message:set-status', id, status),
  invokeAction: (workstream, command, args) => invoke('action:invoke', workstream, command, args),
  runContainerApp: (id) => invoke('container:run', id),
  inspectContainerApp: (id) => invoke('container:inspect', id),
  stopContainerApp: (id) => invoke('container:stop', id),
  openContainerApp: (id) => invoke('container:open', id),
  getAppMcpStatus: (id) => invoke('app-mcp:status', id),
  connectAppMcp: (id) => invoke('app-mcp:connect', id),
  disconnectAppMcp: (id) => invoke('app-mcp:disconnect', id),
  listAppMcpTools: (id) => invoke('app-mcp:list-tools', id),
  callAppMcpTool: (id, name, args) => invoke('app-mcp:call-tool', id, name, args),
  getAppResourceContract: (id) => invoke('app-mcp:contract', id),
  restartDesktop: () => ipcRenderer.send('app:restart'),
  openExternal: (url) => invoke('external:open', url),
};

contextBridge.exposeInMainWorld('workingMemory', api);