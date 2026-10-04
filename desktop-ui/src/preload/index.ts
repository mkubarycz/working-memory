import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, SaveConfigInput } from '../shared/contracts';
import { toIpcPayload } from './ipcPayload';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args.map(toIpcPayload)) as Promise<T>;
}

const api: DesktopApi = {
  listContainerApps: () => invoke('container:list'),
  discoverEnvironments: () => invoke('environment:discover'),
  switchEnvironment: (mcpUrl) => invoke('environment:switch', mcpUrl),
  getActivePanel: () => invoke('active:get'),
  reorderWorkstreams: (updates) => invoke('active:reorder', updates),
  getConfig: () => invoke('config:get'),
  saveConfig: (input: SaveConfigInput) => invoke('config:save', input),
  testConnection: (input: SaveConfigInput) => invoke('config:test', input),
  sendChat: (message, context) => invoke('chat:send', message, context),
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
  togglePin: (workstream, topic) => invoke('topic:toggle-pin', workstream, topic),
  setAlertStatus: (context, id, status) => invoke('alert:set-status', context, id, status),
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