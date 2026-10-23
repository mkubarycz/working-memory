import type {
  AttachmentRef,
  AttachmentUpload,
  DocumentVM,
  TopicPatch,
  TopicTypeMetaVM,
  WorkstreamVM,
} from '../renderer/documents/types';
import type { PanelData } from '../../../shared/panelData';
import type { DocumentChanges } from '../../../shared/documentChanges';
import type { HostTaskDesktopApi } from './hostTasks';
import type { WorkstreamSection } from '../../../shared/panelData';
import type {
  ApplicationContractMetadata,
  AgentMessageDecisionInput,
  CommandJournal,
  CommandJournalHistoryInput,
  CommandJournalHistoryPage,
  CommandJournalStatus,
} from '../../../shared/controlPlaneClient';
import type { AgentMessageVM } from '../../../shared/viewModels/agentMessageVms';

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
  claimId: string;
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
  embeddable?: boolean;
  mcp?: AppMcpEndpoint;
  application?: ApplicationContractMetadata;
}

export interface ContainerAppResourceReference {
  version: 2;
  appId: ContainerAppId;
  resourceKind: string;
  resourceId: string;
  title: string;
  deepLink: string;
  preview?: {
    date?: string;
    description?: string;
    amount?: string;
    details?: Array<{ label: string; value: string }>;
  };
  context?: {
    markdown?: string;
  };
}

export interface PublicConfig {
  endpoint: string;
  model: string;
  hasApiKey: boolean;
  credentialStorage: 'secure' | 'local' | 'session' | 'unavailable';
  humanName: string;
  profiles: PublicModelProfile[];
  routing: ModelRouting;
}

export type AiSpeed = 'slow' | 'medium' | 'fast';
export type AiDepth = 'simple' | 'complex' | 'deep';
export type AiRouteKey = `${AiDepth}:${AiSpeed}`;
export type ModelRouting = Record<AiRouteKey, string>;
export type ModelProvider = 'openai-compatible' | 'copilot';

export interface CopilotModels {
  account: string;
  models: Array<{ id: string; name: string }>;
}

export interface PublicModelProfile {
  id: string;
  name: string;
  provider: ModelProvider;
  endpoint: string;
  model: string;
  hasApiKey: boolean;
}

export interface EditableModelProfile extends PublicModelProfile {
  apiKey?: string;
}

export interface SaveConfigInput {
  profiles: EditableModelProfile[];
  routing: ModelRouting;
  humanName: string;
}

export interface ConnectionResult {
  ok: boolean;
  message: string;
}

export interface ChatPromptImage {
  attachment: AttachmentRef;
}

export interface TopicAutocompleteInput {
  body: string;
  currentTitle: string;
  currentTopicType: string;
  topicTypes: Array<{ id: string; label: string; description: string }>;
  currentWorkstreamTitle?: string;
}

export interface TopicAutocompleteResult {
  title: string;
  topicType: string;
  workstreamTitle?: string;
}

export interface BackendHealth {
  state: 'healthy' | 'unreachable';
  endpoint: string;
  result: string;
  observedAt: number;
  source: DesktopEnvironment['source'];
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

  title: string;
}

export function chatContextForDocument(document: ChatContextDocument | null): ChatContext | undefined {
  if (!document) return undefined;
  if (
    document.kind === 'topic-create'
    || document.kind === 'topic-backlog'
    || document.kind === 'settings'
    || document.kind === 'host-tasks'
  ) return undefined;
  const identifier = (document.id).trim();
  if (!identifier) return undefined;
  const routeKind = document.kind === 'AgentMessage' || document.kind === 'alert'
    ? 'agent-message'
    : ['workstream', 'topic', 'agent-message', 'topic-type'].includes(document.kind)
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
  batchCount?: number;
  batchActions?: Array<{
    tool: string;
    count: number;
    summary: string;
    arguments: Record<string, unknown>;
  }>;
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

export type DesktopResourceKind = 'workstream' | 'topic' | 'document' | 'agent-message' | 'alert' | 'topic-type';

export interface TopicCreateInput {
  title: string;
  body: string;
  topicType: string;
  workstream: string;
  parent?: string;
}

export interface DesktopWorkstreamReorderUpdate {
  id: string;
  section: WorkstreamSection;
  position: number;
}

export interface PreparedResourceDrag {
  filename: string;
  filePath: string;
  fileUrl: string;
}

export interface ResourceDragResult {
  filePath: string;
  status: 'started' | 'failed';
  error?: string;
}

/** Off: never download (local builds); Canary: latest main build; Stable: tagged releases. */
export type UpdateChannel = 'off' | 'canary' | 'stable';

export interface DesktopUpdateState {
  /** False when this build cannot replace itself (local builds, unsupported platforms). */
  supported: boolean;
  unsupportedReason: string | null;
  currentVersion: string;
  channel: UpdateChannel;
  phase: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  available: { version: string; publishedAt: string | null; releaseUrl: string } | null;
  /** Download progress between 0 and 1 while downloading. */
  progress: number | null;
  error: string | null;
  checkedAt: string | null;
}

export interface BackendUpdateTarget {
  version: string;
  /** Fully qualified image reference, for example ghcr.io/…/working-memory-control-plane:1.0.0. */
  image: string;
}

/** A Docker data-tier instance created by this desktop install. */
export interface ManagedDataTierInstance {
  port: number;
  name: string;
  createdAt: string;
  /** Image the instance was last composed with; absent means the image bundled with the app. */
  image?: string;
}

export type DataTierInstanceState = 'running' | 'starting' | 'unhealthy' | 'stopped' | 'missing' | 'unknown';

export interface DataTierInstanceStatus extends ManagedDataTierInstance {
  mcpUrl: string;
  container: string;
  state: DataTierInstanceState;
  /** Backend version the container runs, or null when unknown. */
  version: string | null;
  /** True when the container differs from the backend channel's target version. */
  updateAvailable: boolean;
}

export interface DataTierInstancesSnapshot {
  appVersion: string;
  backendChannel: UpdateChannel;
  /** Version instances should run for the backend channel; Off targets the bundled image. */
  backendTarget: BackendUpdateTarget | null;
  /** Why the channel target could not be resolved, for example while offline. */
  backendTargetError: string | null;
  /** Null when Docker is reachable; otherwise why instance status is unavailable. */
  dockerError: string | null;
  instances: DataTierInstanceStatus[];
  /** Reachable Working Memory servers this app did not create: connect-only. */
  selfHosted: SelfHostedInstance[];
}

export interface SelfHostedInstance {
  port: number;
  name: string;
  mcpUrl: string;
}

export type DocumentChangeEvent = { mcpUrl: string } & (
  | { change: DocumentChanges }
  | { error: string }
);

export interface SharedTopicReceipt {
  id: string;  title: string; duplicate: boolean; statusUrl: string; submittedAt: string;
}
export interface FeedbackServer { id: string; name: string; address: string }
export interface FeedbackContext {
  desktop: { version: string; build: string };
  backend: { version: string };
}
export interface FeedbackPreparation { servers: FeedbackServer[]; context: FeedbackContext }
export type FeedbackSendResult = { status: 'sent'; receipt: SharedTopicReceipt } | { status: 'choose'; servers: FeedbackServer[] };

export interface DesktopApi extends HostTaskDesktopApi {
  prepareFeedback(id: string, requestId: string): Promise<FeedbackPreparation>;
  sendFeedback(id: string, requestId: string, serverId?: string): Promise<FeedbackSendResult>;
  startDocumentChanges(): Promise<void>;
  onDocumentChanges(listener: (event: DocumentChangeEvent) => void): () => void;
  listContainerApps(): Promise<ContainerAppDefinition[]>;
  discoverEnvironments(): Promise<DesktopEnvironmentState>;
  switchEnvironment(mcpUrl: string): Promise<DesktopEnvironmentState>;
  /** Null when this build cannot manage data-tier instances (no bundled data tier). */
  listInstances(): Promise<DataTierInstancesSnapshot | null>;
  createInstance(name?: string): Promise<DataTierInstancesSnapshot | null>;
  startInstance(port: number): Promise<DataTierInstancesSnapshot | null>;
  stopInstance(port: number): Promise<DataTierInstancesSnapshot | null>;
  /** Recreates the instance on the backend channel's target version, keeping its data. */
  upgradeInstance(port: number): Promise<DataTierInstancesSnapshot | null>;
  setBackendUpdateChannel(channel: UpdateChannel): Promise<DataTierInstancesSnapshot | null>;
  getDesktopUpdate(): Promise<DesktopUpdateState>;
  setDesktopUpdateChannel(channel: UpdateChannel): Promise<DesktopUpdateState>;
  checkDesktopUpdate(): Promise<DesktopUpdateState>;
  downloadDesktopUpdate(): Promise<DesktopUpdateState>;
  /** Quits, installs the downloaded update, and relaunches. */
  installDesktopUpdate(): Promise<void>;
  onDesktopUpdate(listener: (state: DesktopUpdateState) => void): () => void;
  renameInstance(port: number, name: string): Promise<DataTierInstancesSnapshot | null>;
  /** Returns the backup file path, or null when the folder picker was cancelled. */
  backupInstance(port: number): Promise<string | null>;
  getActivePanel(): Promise<PanelData>;
  reorderWorkstreams(updates: DesktopWorkstreamReorderUpdate[]): Promise<void>;
  getConfig(): Promise<PublicConfig>;
  getBackendHealth(): Promise<BackendHealth>;
  getOpenAiHealth(): Promise<ConnectionResult>;
  saveConfig(input: SaveConfigInput): Promise<PublicConfig>;
  testConnection(input: SaveConfigInput): Promise<ConnectionResult>;
  testModelProfile(input: EditableModelProfile): Promise<ConnectionResult>;
  listCopilotModels(): Promise<CopilotModels>;
  sendChat(message: string, context?: ChatContext, images?: ChatPromptImage[]): Promise<ChatResult>;
  autocompleteTopic(input: TopicAutocompleteInput): Promise<TopicAutocompleteResult>;
  resolveChatConfirmation(id: string, confirmed: boolean, context?: ChatContext): Promise<ChatResult>;
  getChatHistory(input?: CommandJournalHistoryInput): Promise<CommandJournalHistoryPage>;
  getChatJournal(id: string): Promise<CommandJournal | null>;
  openWorkstream(query: string): Promise<ChatResult>;
  openResource(kind: DesktopResourceKind, identifier: string): Promise<DocumentVM>;
  onOpenResource(listener: (kind: DesktopResourceKind, identifier: string) => void): () => void;
  prepareResourceDrag(openUri: string, label: string): Promise<PreparedResourceDrag>;
  startResourceDrag(prepared: PreparedResourceDrag): void;
  onResourceDragResult(listener: (result: ResourceDragResult) => void): () => void;
  saveWorkstream(identifier: string, patch: { title?: string; status?: string }): Promise<DocumentVM>;
  saveTopic(identifier: string, patch: TopicPatch): Promise<DocumentVM>;
  listTopicTypes(): Promise<TopicTypeMetaVM[]>;
  createWorkstream(title: string): Promise<{ id: string; title: string }>;
  createTopic(input: TopicCreateInput): Promise<DocumentVM>;
  reparentTopic(id: string, parent: string | null): Promise<void>;
  uploadAttachment(file: AttachmentUpload): Promise<AttachmentRef>;
  togglePin(workstream: string, topic: string): Promise<DocumentVM>;
  getAgentMessages(input?: { limit?: number; offset?: number }): Promise<AgentMessageVM[]>;
  recordAgentMessageDecision(id: string, decision: AgentMessageDecisionInput): Promise<void>;
  setAgentMessageStatus(
    id: string,
    status: AgentMessageVM['status'],
  ): Promise<void>;
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
  restartDesktop(): void;
  openExternal(url: string): Promise<void>;
}