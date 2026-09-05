import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi, SaveConfigInput } from '../shared/contracts';
import { toIpcPayload } from './ipcPayload';

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args.map(toIpcPayload)) as Promise<T>;
}

const api: DesktopApi = {
  getActivePanel: () => invoke('active:get'),
  getConfig: () => invoke('config:get'),
  saveConfig: (input: SaveConfigInput) => invoke('config:save', input),
  testConnection: (input: SaveConfigInput) => invoke('config:test', input),
  sendChat: (message, context) => invoke('chat:send', message, context),
  resolveChatConfirmation: (id, confirmed, context) => invoke('chat:confirm', id, confirmed, context),
  openWorkstream: (query: string) => invoke('workstream:open', query),
  openResource: (kind, identifier) => invoke('resource:open', kind, identifier),
  saveWorkstream: (identifier, patch) => invoke('workstream:save', identifier, patch),
  saveTopic: (identifier, patch) => invoke('topic:save', identifier, patch),
  togglePin: (workstream, topic) => invoke('topic:toggle-pin', workstream, topic),
  setAlertStatus: (context, id, status) => invoke('alert:set-status', context, id, status),
  invokeAction: (workstream, command, args) => invoke('action:invoke', workstream, command, args),
  openExternal: (url) => invoke('external:open', url),
};

contextBridge.exposeInMainWorld('workingMemory', api);