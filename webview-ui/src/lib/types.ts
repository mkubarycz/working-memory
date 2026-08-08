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
  title: string;
  /** Topic slug (or id) used to build the deep link / open request. */
  slug: string;
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

/** A nanite run rendered as a leaf in the workstream tree (mirrors the rail). */
export interface TreeNaniteVM {
  kind: 'nanite';
  /** Stable row id (composed by the rail's builder). */
  id: string;
  label: string;
  /** Codicon id for the run's lifecycle phase. */
  icon: string;
  /** Lifecycle phase text (Pending / Queued / Running / Succeeded / Failed). */
  phase: string;
  /** Raw nanite id used to open its generic document view. */
  openId: string;
  /** Right-click lifecycle actions ported from the rail (run / reset / restart). */
  actions: TreeActionVM[];
}

/** A topic node in the workstream tree — nests child topics + its nanite runs. */
export interface TreeTopicVM {
  kind: 'topic';
  id: string;
  label: string;
  /** Codicon id sourced from the topic type. */
  icon: string;
  status: string;
  /** Topic slug used to open it. */
  slug: string;
  /** True when this topic is pinned/focused in THIS workstream. */
  pinned: boolean;
  /** Nested child topics and this topic's nanite runs. */
  children: Array<TreeTopicVM | TreeNaniteVM>;
  /** Right-click actions ported from the rail (currently topic updates). */
  actions: TreeActionVM[];
}

/** A top-level group in the workstream tree ("Topics (N)" / "Nanites (N)"). */
export interface TreeGroupVM {
  kind: 'group';
  id: string;
  label: string;
  /** Codicon id for the group header. */
  icon: string;
  children: Array<TreeTopicVM | TreeNaniteVM>;
}

/** The workstream detail view-model (kind = workstream). */
export interface WorkstreamVM {
  kind: 'workstream';
  title: string;
  slug: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  closure: string | null;
  resourceVersion: number;
  /** False for slugless workstreams (can't be edited via the ws-* API yet). */
  editable: boolean;
  topics: WorkstreamTopicVM[];
  /** Full nested topic + nanite tree, mirroring the left rail's card. */
  tree: TreeGroupVM[];
}

/** A related document reference (parent topic, member workstream, …). */
export interface RelationVM {
  /** Slug or id used to build the open request. */
  slug: string;
  title: string;
}

/**
 * Topic-type metadata sourced from the control-plane TopicType kind. Drives the
 * type-aware header icon + label. Null when the type couldn't be resolved.
 */
export interface TopicTypeMetaVM {
  slug: string | null;
  label: string;
  /** Codicon id (e.g. 'rocket', 'checklist'). */
  icon: string;
  description: string;
}

/** The topic detail view-model (kind = topic). */
export interface TopicVM {
  kind: 'topic';
  title: string;
  slug: string | null;
  status: string;
  /** The topic-type slug (e.g. 'feature', 'bug'). */
  topicType: string;
  /** Resolved topic-type metadata (icon + label), or null when unresolved. */
  typeMeta: TopicTypeMetaVM | null;
  body: string;
  createdAt: number;
  updatedAt: number;
  resourceVersion: number;
  /** False for slugless topics (can't be edited via ws-topic-update yet). */
  editable: boolean;
  parents: RelationVM[];
  workstreams: RelationVM[];
  focusedWorkstreams: RelationVM[];
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
  slug: string | null;
  title: string;
  createdAt: number;
  updatedAt: number;
  resourceVersion: number;
  spec: GenericFieldVM[];
}

/** The discriminated document view-model pushed from the extension host. */
export type DocumentVM = WorkstreamVM | TopicVM | GenericDocVM;

/**
 * Save-status the header indicator renders. `saved` (green) only ever fires on
 * a host-confirmed write (the `saved` ack), never merely on posting a patch.
 */
export type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

/** Messages the extension host sends TO the webview. */
export type ExtToWebview =
  | { type: 'document'; data: DocumentVM }
  | { type: 'saved'; resourceVersion?: number }
  | { type: 'error'; message: string }
  // Non-terminal startup state: the control plane isn't connected yet, so the
  // webview shows "connecting…" and waits for a refresh to heal it (Bug B).
  | { type: 'connecting' }
  // A newer server version exists but the user has unsaved edits — surface a
  // "content changed — reload" affordance instead of overwriting (Bug A).
  | { type: 'staleReload' };

/** A topic edit patch (title / status / body). */
export interface TopicPatch {
  title?: string;
  status?: string;
  body?: string;
}

/** Messages the webview sends TO the extension host. */
export type WebviewToExt =
  | { type: 'ready' }
  | { type: 'save'; patch: { title?: string; status?: string } }
  | { type: 'saveTopic'; patch: TopicPatch }
  | { type: 'openTopic'; slug: string }
  | { type: 'openWorkstream'; slug: string }
  | { type: 'openDocument'; id: string }
  | { type: 'invoke'; command: string; args: unknown[] }
  | { type: 'togglePinTopic'; slug: string }
  // Reports whether the webview currently holds un-flushed local edits so the
  // host's refresh decision won't stomp in-progress work (Bug A).
  | { type: 'editState'; hasPendingEdits: boolean }
  // The user clicked the reload banner: discard local edits + take the server
  // version.
  | { type: 'discardAndReload' };
