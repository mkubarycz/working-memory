import type { AlertVM, DocumentVM, TopicPatch, WorkstreamVM } from '../../../webview-ui/src/lib/types';
import type { PanelData } from '../../../src/panelData';
import type { WorkstreamSection } from '../../../src/panelData';
import type {
  CommandJournal,
  CommandJournalHistoryInput,
  CommandJournalHistoryPage,
  CommandJournalStatus,
} from '../../../src/controlPlaneClient';

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

export type ContainerLaunchResult =
  | {
      status: 'ready';
      url: string;
      action: 'created' | 'started' | 'recreated' | 'reused';
    }
  | {
      status: 'error';
      code:
        | 'docker_missing'
        | 'docker_unavailable'
        | 'docker_timeout'
        | 'source_not_found'
        | 'claim_error'
        | 'container_conflict'
        | 'build_failed'
        | 'start_failed'
        | 'stop_failed'
        | 'unhealthy'
        | 'readiness_timeout';
      message: string;
    };

export type ContainerAppState = 'missing' | 'stopped' | 'running' | 'healthy' | 'unhealthy' | 'error';

export interface ContainerAppStatus {
  id: string;
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
}

export interface ContainerStopResult {
  status: 'stopped' | 'already_stopped' | 'missing' | 'error';
  message: string;
  detail: ContainerAppStatus;
}

export type ContainerAppId = 'clarinet-hero';

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
  openExternal(url: string): Promise<void>;
}