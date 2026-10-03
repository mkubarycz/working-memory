import type { AlertVM, DocumentVM, TopicPatch, WorkstreamVM } from '../../../webview-ui/src/lib/types';
import type { PanelData } from '../../../src/panelData';
import type { WorkstreamSection } from '../../../src/panelData';
import type {
  ApplicationContractMetadata,
  CommandJournal,
  CommandJournalHistoryInput,
  CommandJournalHistoryPage,
  CommandJournalStatus,
} from '../../../src/controlPlaneClient';

export type ContainerAppId = string;

export interface AppMcpEndpoint {
  transport: 'streamable-http';
  url: string;
}

export interface McpToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface AppMcpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: McpToolAnnotations;
}

export interface AppMcpToolListing {
  connectionId: number;
  endpoint: AppMcpEndpoint;
  tools: AppMcpTool[];
}

export interface AppMcpStatus {
  appId: ContainerAppId;
  endpoint?: AppMcpEndpoint;
  connectionId?: number;
  state: 'unavailable' | 'disconnected' | 'connected' | 'error';
  error: string | null;
}

export interface AppResourceContract {
  contractVersion: string;
  application: {
    id: string;
    name?: string;
    title?: string;
    version?: string;
    description?: string;
  };
  envelope: Record<string, unknown>;
  resources: Record<string, unknown> | Array<Record<string, unknown>>;
  operations?: Array<Record<string, unknown>>;
  errors?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
}

export type ContainerAppState = 'missing' | 'stopped' | 'running' | 'healthy' | 'unhealthy' | 'error';

export interface ContainerAppStatus {
  id: ContainerAppId;
  displayName: string;
  claimTitle: string;
  claimSlug: string;
  repository: string;
  buildContext: string;
  dockerfile: string;
  image: string;
  containerName: string;
  dockerContext: string | null;
  state: ContainerAppState;
  hostPort: number;
  containerPort: number;
  url: string;
  ready: boolean;
  lastAction: string;
  error: string | null;
  mcp?: AppMcpEndpoint;
  application?: ApplicationContractMetadata;
}

export interface ContainerStopResult {
  status: 'stopped' | 'already_stopped' | 'missing' | 'error';
  message: string;
  detail: ContainerAppStatus;
}

export type ContainerLaunchResult =
  | { status: 'ready'; url: string; action: 'created' | 'started' | 'recreated' | 'reused' }
  | { status: 'error'; code: string; message: string };

export interface ContainerAppDefinition {
  id: ContainerAppId;
  displayName: string;
  icon: string;
  mcp?: AppMcpEndpoint;
  application?: ApplicationContractMetadata;
}

export interface PublicConfig {
  endpoint: string;
  model: string;
  hasApiKey: boolean;
  credentialStorage: 'secure' | 'session' | 'unavailable';
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

export interface DesktopEnvironment {
  id: string;
  port: number;
  displayName: string;
  mcpUrl: string;
  source: 'production' | 'override' | 'sandbox';
}

export interface DesktopEnvironmentState {
  environments: DesktopEnvironment[];
  selected: DesktopEnvironment | null;
}

export interface ChatContext {
  kind: string;
  routeKind: DesktopResourceKind;
  identifier: string;
  title: string;
  containerAppId?: ContainerAppId;
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
  return {
    kind: document.kind,
    routeKind,
    identifier,
    title: document.title.trim() || identifier,
    ...(document.kind === 'container-app' ? { containerAppId: identifier } : {}),
  };
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
  journalId?: string;
  message: string;
  status: CommandJournalStatus;
  mutated?: boolean;
  workstream?: WorkstreamVM;
  document?: DocumentVM;
  progress?: ToolProgress[];
  pendingConfirmation?: PendingConfirmation;
}

export type DesktopResourceKind = 'workstream' | 'topic' | 'document' | 'alert' | 'topic-type';

export interface DesktopWorkstreamReorderUpdate {
  slug: string;
  section: WorkstreamSection;
  position: number;
}

export interface DesktopApi {
  listContainerApps(): Promise<ContainerAppDefinition[]>;
  discoverEnvironments(): Promise<DesktopEnvironmentState>;
  switchEnvironment(mcpUrl: string): Promise<DesktopEnvironmentState>;
  getActivePanel(): Promise<PanelData>;
  reorderWorkstreams(updates: DesktopWorkstreamReorderUpdate[]): Promise<void>;
  getConfig(): Promise<PublicConfig>;
  saveConfig(input: SaveConfigInput): Promise<PublicConfig>;
  testConnection(input: SaveConfigInput): Promise<ConnectionResult>;
  sendChat(message: string, context?: ChatContext): Promise<ChatResult>;
  resolveChatConfirmation(id: string, confirmed: boolean, context?: ChatContext): Promise<ChatResult>;
  getChatHistory(input?: CommandJournalHistoryInput): Promise<CommandJournalHistoryPage>;
  getChatJournal(id: string): Promise<CommandJournal | null>;
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
  runContainerApp(id: ContainerAppId): Promise<ContainerLaunchResult>;
  inspectContainerApp(id: ContainerAppId): Promise<ContainerAppStatus>;
  stopContainerApp(id: ContainerAppId): Promise<ContainerStopResult>;
  openContainerApp(id: ContainerAppId): Promise<ContainerAppStatus>;
  getAppMcpStatus(id: ContainerAppId): Promise<AppMcpStatus>;
  connectAppMcp(id: ContainerAppId): Promise<AppMcpStatus>;
  disconnectAppMcp(id: ContainerAppId): Promise<AppMcpStatus>;
  listAppMcpTools(id: ContainerAppId): Promise<AppMcpTool[]>;
  callAppMcpTool(id: ContainerAppId, name: string, args: Record<string, unknown>): Promise<unknown>;
  getAppResourceContract(id: ContainerAppId): Promise<AppResourceContract>;
  openExternal(url: string): Promise<void>;
}