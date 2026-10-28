import type { PanelTopicRow } from '../../../../shared/panelData';

/**
 * Shared view-model + message types for the unified `.working-memory` document
 * custom editor (WM 14.2 "svelte-document-editor").
 *
 * The control plane is a GENERIC document store, so the webview is ONE editor
 * that dispatches its UI by document `kind`. These types describe the
 * postMessage contract between the Svelte webview and the extension host. The
 * extension host has its OWN structural copy of these shapes (in
 * `src/webview/documentEditorProvider.ts`) because the webview and extension are
 * separate TypeScript programs — keep the two in sync by hand.
 */

/** A single topic row rendered in the workstream's Topics section. */
export interface WorkstreamTopicVM {
  id: string;
  title: string;

  status: string;
  /** True when this topic is pinned to THIS workstream (focusedWorkstreams). */
  pinned: boolean;
}

/** A context-menu action ported from the rail (a VS Code command + args). */
export interface TreeActionVM {
  command: string;
  title: string;
  /** Codicon id (empty string when the rail action had none). */
  icon: string;
  args: unknown[];
  enabled: boolean;
}

/** A topic node in the workstream tree. */
export interface TreeTopicVM {
  kind: 'topic';
  id: string;
  documentId?: string;
  label: string;
  /** Codicon id sourced from the topic type. */
  icon: string;
  status: string;
  /** Topic id used to open it. */

  /** True when this topic is pinned/focused in THIS workstream. */
  pinned: boolean;
  /** Open agent messages requiring attention; 0 hides the badge. */
  agentMessageCount: number;
  /** Highest severity among messages requiring attention. */
  agentMessageSeverity: 'info' | 'warning' | 'error' | null;
  /** Nested child topics. */
  children: TreeTopicVM[];
  /** Right-click actions ported from the rail (currently topic updates). */
  actions: TreeActionVM[];
}

/** A top-level topic group in the workstream tree. */
export interface TreeGroupVM {
  kind: 'group';
  id: string;
  label: string;
  /** Codicon id for the group header. */
  icon: string;
  children: TreeTopicVM[];
}

/** The workstream detail view-model (kind = workstream). */
export interface WorkstreamVM {
  kind: 'workstream';
  id: string;
  title: string;

  status: string;
  createdAt: number;
  updatedAt: number;
  closure: string | null;
  resourceVersion: number;
  /** Whether this workstream permits authored edits. */
  editable: boolean;
  topics: WorkstreamTopicVM[];
  /** Full nested topic tree, mirroring the left rail's card. */
  tree: TreeGroupVM[];
  /** Complete canonical agent message history relevant to this workstream. */
  agentMessages: AgentMessageVM[];
}

/** A related document reference (parent topic, member workstream, …). */
export interface RelationVM {
  /** Related resource document ID. */
  id: string;
  title: string;
  /** Number of open agent messages requiring attention. */
  agentMessageCount: number;
  /** Highest severity among messages requiring attention. */
  agentMessageSeverity: 'info' | 'warning' | 'error' | null;
}

/** Canonical persisted AgentMessage, not a chat run or a tool execution request. */
export interface AgentMessageVM {
  /** AgentMessage document ID used for links and message-only lifecycle transitions. */
  id: string;
  agentId: string;
  agentName: string;
  title: string;
  description: string;
  recommendedAction: string;
  /** Acknowledgement and resolution do not authorize a tool or topic change. */
  status: 'open' | 'acknowledged' | 'resolved';
  category: 'request' | 'approval' | 'error' | 'completion';
  severity: 'info' | 'warning' | 'error';
  attention: boolean;
  topics: string[];
  relations: { kind: string; id: string }[];
  /** Recorded communication only; never an execution grant or action payload. */
  decision?: {
    outcome: 'approved' | 'rejected';
    decided_by: string;
    reason?: string;
    decided_at?: number;
  };
  /** Canonical document timestamps are epoch seconds (chat run timestamps are milliseconds). */
  createdAt: number;
  updatedAt: number;

  provenance?: unknown;
}

export type RecordAgentMessageDecision = (
  id: string, outcome: 'approved' | 'rejected', decidedBy: string,
) => void | Promise<void>;

/**
 * Topic-type metadata sourced from the control-plane TopicType kind. Drives the
 * type-aware header icon + label. Null when the type couldn't be resolved.
 */
export interface TopicTypeMetaVM {
  id: string;
  label: string;
  /** Codicon id (e.g. 'rocket', 'checklist'). */
  icon: string;
  description: string;
}

/** Local-only document tab used while authoring a topic before its first save. */
export interface TopicCreateDraftVM {
  kind: 'topic-create';
  id: string;

  title: string;
  body: string;
  topicType: string;
  topicTypes: TopicTypeMetaVM[];
  workstream: string;
  workstreamTitle: string;
  newWorkstreamTitle?: string;
  parent: string | null;
  parentTitle: string | null;
}

export interface TopicBacklogVM {
  kind: 'topic-backlog';
  id: 'open-topic-backlog';

  title: 'Open topic backlog';
  topics: PanelTopicRow[];
}

export interface SettingsVM {
  kind: 'settings';
  id: 'desktop-settings';

  title: 'Settings';
}

export interface HostTaskVM {
  kind: 'host-task';
  id: string;
  title: string;
}

export interface HostTaskCreateVM {
  kind: 'host-task-create';
  id: 'new-host-task';
  title: 'Add host task';
}

/** The topic detail view-model (kind = topic). */
export interface TopicVM {
  kind: 'topic';
  /** Null only for the unsaved topic creation preview. */
  id: string | null;
  title: string;

  status: string;
  /** The TopicType document ID. */
  topicType: string;
  /** Resolved topic-type metadata (icon + label), or null when unresolved. */
  typeMeta: TopicTypeMetaVM | null;
  /** Available topic types for the editable header selector. */
  topicTypes?: TopicTypeMetaVM[];
  body: string;
  createdAt: number;
  updatedAt: number;
  resourceVersion: number;
  /** Whether this topic permits authored edits. */
  editable: boolean;
  parents: RelationVM[];
  /** Child topics — topics whose `parents` include this topic (the DAG below). */
  children: RelationVM[];
  workstreams: RelationVM[];
  focusedWorkstreams: RelationVM[];
  /** Complete canonical agent message history relevant to this topic. */
  agentMessages: AgentMessageVM[];
}

/** A flattened `spec` field rendered by the generic fallback view. */
export interface GenericFieldVM {
  key: string;
  value: string;
}

/**
 * The generic fallback view-model — rendered for ANY kind that has no bespoke
 * view, so nothing is ever unopenable. Carries the shared envelope + a readable
 * list of `spec` fields.
 */
export interface GenericDocVM {
  /** The document's real kind (arbitrary; NOT 'workstream' | 'topic'). */
  kind: string;
  id: string;

  title: string;
  createdAt: number;
  updatedAt: number;
  resourceVersion: number;
  spec: GenericFieldVM[];
}

/** The discriminated document view-model pushed from the extension host. */
export type DocumentVM =
  | WorkstreamVM
  | TopicVM
  | TopicCreateDraftVM
  | TopicBacklogVM
  | SettingsVM
  | HostTaskVM
  | HostTaskCreateVM
  | GenericDocVM;

/**
 * Save-status the header indicator renders. `saved` (green) only ever fires on
 * a host-confirmed write (the `saved` ack), never merely on posting a patch.
 */
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/** Messages the extension host sends TO the webview. */
export type ExtToWebview =
  | { type: 'document'; data: DocumentVM; attachmentBaseUrl?: string }
  | { type: 'saved'; resourceVersion?: number }
  | { type: 'imagesAttached'; requestId: string; attachments: AttachmentRef[] }
  | { type: 'imagesAttachFailed'; requestId: string; message: string }
  | { type: 'error'; message: string }
  // Non-terminal startup state: the control plane isn't connected yet, so the
  // webview shows "connecting…" and waits for a refresh to heal it (Bug B).
  | { type: 'connecting' }
  // A newer server version exists but the user has unsaved edits — surface a
  // "content changed — reload" affordance instead of overwriting (Bug A).
  | { type: 'staleReload' }
;

/** A topic edit patch (title / status / body). */
export interface TopicPatch {
  title?: string;
  status?: string;
  body?: string;
  topicType?: string;
}

export interface AttachmentUpload {
  name: string;
  type: string;
  data: ArrayBuffer;
}

export interface AttachmentRef {
  id: string;
  filename: string;
  mimeType: string;
}

/** Messages the webview sends TO the extension host. */
export type WebviewToExt =
  | { type: 'ready' }
  | { type: 'save'; patch: { title?: string; status?: string } }
  | { type: 'saveTopic'; patch: TopicPatch }
  | { type: 'openTopic'; id: string }
  | { type: 'openWorkstream'; id: string }
  | { type: 'invoke'; command: string; args: unknown[] }
  | { type: 'togglePinTopic'; id: string }
  | { type: 'attachImages'; requestId: string; files: AttachmentUpload[] }
  // Message lifecycle transitions never authorize tool execution.
  | { type: 'setAgentMessageStatus'; id: string; status: AgentMessageVM['status'] }
  // Reports whether the webview currently holds un-flushed local edits so the
  // host's refresh decision won't stomp in-progress work (Bug A).
  | { type: 'editState'; hasPendingEdits: boolean }
  // The user clicked the reload banner: discard local edits + take the server
  // version.
  | { type: 'discardAndReload' }
;
