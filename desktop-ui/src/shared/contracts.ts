import type { AlertVM, DocumentVM, TopicPatch, WorkstreamVM } from '../../../webview-ui/src/lib/types';
import type { PanelData } from '../../../src/panelData';

export interface PublicConfig {
  endpoint: string;
  model: string;
  hasApiKey: boolean;
}

export interface SaveConfigInput {
  endpoint: string;
  model: string;
  apiKey?: string;
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
}

export interface ChatContext {
  kind: string;
  routeKind: DesktopResourceKind;
  identifier: string;
  title: string;
}

interface ChatContextDocument {
  kind: string;
  id: string;
  slug: string | null;
  title: string;
}

export function chatContextForDocument(document: ChatContextDocument | null): ChatContext | undefined {
  if (!document) return undefined;
  const identifier = (document.slug ?? document.id).trim();
  if (!identifier) return undefined;
  const routeKind = ['workstream', 'topic', 'alert', 'topic-type'].includes(document.kind)
    ? document.kind as DesktopResourceKind
    : 'document';
  return { kind: document.kind, routeKind, identifier, title: document.title.trim() || identifier };
}

export interface ToolProgress {
  name: string;
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
}

export interface PendingConfirmation {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
}

export interface ChatResult {
  message: string;
  workstream?: WorkstreamVM;
  document?: DocumentVM;
  progress?: ToolProgress[];
  pendingConfirmation?: PendingConfirmation;
}

export type DesktopResourceKind = 'workstream' | 'topic' | 'document' | 'alert' | 'topic-type';

export interface DesktopApi {
  getActivePanel(): Promise<PanelData>;
  getConfig(): Promise<PublicConfig>;
  saveConfig(input: SaveConfigInput): Promise<PublicConfig>;
  testConnection(input: SaveConfigInput): Promise<ConnectionResult>;
  sendChat(message: string, context?: ChatContext): Promise<ChatResult>;
  resolveChatConfirmation(id: string, confirmed: boolean, context?: ChatContext): Promise<ChatResult>;
  openWorkstream(query: string): Promise<ChatResult>;
  openResource(kind: DesktopResourceKind, identifier: string): Promise<DocumentVM>;
  saveWorkstream(identifier: string, patch: { title?: string; status?: string }): Promise<DocumentVM>;
  saveTopic(identifier: string, patch: TopicPatch): Promise<DocumentVM>;
  togglePin(workstream: string, topic: string): Promise<DocumentVM>;
  setAlertStatus(
    context: { kind: 'workstream' | 'topic'; identifier: string },
    id: string,
    status: AlertVM['status'],
  ): Promise<DocumentVM>;
  invokeAction(workstream: string, command: string, args: unknown[]): Promise<DocumentVM>;
  openExternal(url: string): Promise<void>;
}