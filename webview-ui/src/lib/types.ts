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
  /** Open-alert count for the bubble on this tree row; 0 hides it. */
  alertCount: number;
  /** Max open-alert severity, driving the badge color; null when count is 0. */
  alertSeverity: 'alert' | 'informational' | null;
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
  /** Alerts relevant to this workstream (union of its topics' alerts). */
  alerts: AlertVM[];
}

/** A related document reference (parent topic, member workstream, …). */
export interface RelationVM {
  /** Slug or id used to build the open request. */
  slug: string;
  title: string;
  /** Open-alert count for the related topic (0 for workstreams / no alerts). */
  alertCount: number;
  /** Max open-alert severity, driving the badge color; null when count is 0. */
  alertSeverity: 'alert' | 'informational' | null;
}

/**
 * A single alert rendered as a callout on the workstream / topic views. Mirrors
 * the control-plane Alert kind (see `Alert` in the control-plane client) but
 * flattened + scoped for display: `dimmed` is true for a recently-closed alert
 * kept visible only so its Reopen actions remain reachable.
 */
export interface AlertVM {
  /** Alert document id (uuid) — the handle for status transitions. */
  id: string;
  title: string;
  description: string;
  recommendedAction: string;
  /** Authored lifecycle status driving the callout color + button set. */
  status: 'alert' | 'informational' | 'closed';
  updatedAt: number;
  /** True for a closed-but-recent alert (shown muted, still reopenable). */
  dimmed: boolean;
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
  /** Child topics — topics whose `parents` include this topic (the DAG below). */
  children: RelationVM[];
  workstreams: RelationVM[];
  focusedWorkstreams: RelationVM[];
  /** Alerts whose `topics` include this topic's slug. */
  alerts: AlertVM[];
}

/** A flattened `spec` field rendered by the generic fallback view. */
export interface GenericFieldVM {
  key: string;
  value: string;
}

/**
 * One row in a Nanite doc's run-history list (its NaniteJournals), rendered at
 * the bottom of the nanite page styled like a workstream card's topic rows.
 * Structural mirror of `NaniteJournalRowVM` in
 * `src/webview/documentEditorProvider.ts`.
 */
export interface NaniteJournalRowVM {
  /** The NaniteJournal doc id — opens `working-memory:/document/<id>`. */
  id: string;
  /** Terminal outcome driving the row icon (null ⇒ still running/unknown). */
  outcome: 'succeeded' | 'failed' | null;
  /** Lifecycle phase text (Succeeded / Failed / Running / …). */
  phase: string;
  /** A short one-line summary of the run (or its error). */
  summary: string;
  /** Unix seconds the run ended (0 when unknown); the webview formats it. */
  endedAt: number;
  /** Human run duration (e.g. "2.3s", "1m 4s"), or '' when unknown. */
  duration: string;
}

/**
 * A link-out from a NaniteJournal detail view to a related document (the owning
 * Nanite or its NaniteTemplate). Both open via the by-id `/document/<id>` route
 * the panel already uses. `id` is empty when the reference couldn't be resolved
 * (e.g. a nanite with no template), so the view hides the link.
 */
export interface NaniteJournalLinkVM {
  /** Document id used to open it (empty ⇒ unresolved, link hidden). */
  id: string;
  /** Friendly label for the link. */
  title: string;
}

/**
 * One linked item in a multi-result {@link FriendlyReadVM} (list mode). Each
 * item renders as its own clickable link opened via the panel's `onOpenRoute`.
 * Structural mirror of `FriendlyReadItemVM` in
 * `src/webview/documentEditorProvider.ts`.
 */
export interface FriendlyReadItemVM {
  /** Human label (title → name → slug → id), truncated. */
  label: string;
  /** working-memory route to open the item (`/topic/<slug>.working-memory`, …). */
  route: string;
}

/**
 * A friendly summary of a Working-Memory document-READ tool step, derived
 * host-side by `friendlyReadStep` from the step's parsed `result`/`input`. When
 * present, the Execution trace renders a clickable one-line summary instead of
 * raw JSON; the raw INPUT/RESULT stay available on the step's disclosure.
 *
 * Discriminated by `mode`:
 * - `'single'` — a by-slug/id or count-1 read; renders `read <tool>
 *   [<label> (v<version>)]`. `label`/`version`/`route` carry the item; the list
 *   fields are empty (`scope: ''`, `items: []`, `moreCount: 0`).
 * - `'list'`  — a multi-item read; renders `read <tool> <scope> → [A] [B] …`.
 *   `scope` is the input-derived leading text (workstream slug / query, may be
 *   `''`), `items` the linked results (capped), `moreCount` the overflow count;
 *   the single fields are empty (`label: ''`, `version: 0`, `route: ''`).
 *
 * Fields are kept non-optional (with empty sentinels for the unused mode) so
 * the webview↔host contract-parity guard stays a plain field-name comparison.
 * Structural mirror of `FriendlyReadVM` in `src/webview/documentEditorProvider.ts`.
 */
export interface FriendlyReadVM {
  /** Always `'read'` — the friendly verb shown before the tool name. */
  verb: 'read';
  /** The WM read tool that produced the result (e.g. `ws-topic-read`). */
  tool: string;
  /** `'single'` ⇒ label/version/route set; `'list'` ⇒ scope/items/moreCount set. */
  mode: 'single' | 'list';
  /** Single mode: human label for the item (title/name/slug/id), truncated. */
  label: string;
  /** Single mode: the item's `resourceVersion`. */
  version: number;
  /** Single mode: route to open the item (`/topic/<slug>.working-memory`, …). */
  route: string;
  /** List mode: leading scope text derived from input (workstream / query). */
  scope: string;
  /** List mode: the linked result items (capped for readability). */
  items: FriendlyReadItemVM[];
  /** List mode: count of items omitted beyond the cap (0 ⇒ none). */
  moreCount: number;
}

/**
 * The dev container a container-backed tool step ran inside. Structural mirror
 * of `NaniteJournalContainerVM` in `src/webview/documentEditorProvider.ts`.
 * Fields use empty-string sentinels (never optional); `host` empty ⇒ render the
 * label as plain text rather than a clickable link.
 */
export interface NaniteJournalContainerVM {
  /** The run's container id (the `wm-nanite` id-label value). */
  id: string;
  /** OrbStack per-container name (empty when unresolved). */
  name: string;
  /** `<name>.orb.local` host (empty when unresolved) — a clickable https link. */
  host: string;
}

/**
 * One step in a NaniteJournal's execution trace, projected for the expandable
 * per-step disclosure. `kind` labels assistant narration vs a tool call; for a
 * tool step `ok` is its success flag (null for assistant steps).
 */
export interface NaniteJournalStepVM {
  kind: 'assistant' | 'tool';
  /** Display label — "Assistant" for narration, the tool name for a tool call. */
  label: string;
  /** Tool success flag (true/false); null for an assistant step. */
  ok: boolean | null;
  /** Assistant narration text (empty for a tool step). */
  text: string;
  /** Tool-call input, pretty-printed (empty when absent). */
  input: string;
  /** Tool-call result, pretty-printed (empty when absent). */
  result: string;
  /** Step error text (empty when the step didn't error). */
  error: string;
  /** Friendly WM-read summary (null ⇒ render the raw step). */
  friendly: FriendlyReadVM | null;
  /** The dev container this step ran inside (null ⇒ not container-backed). */
  container: NaniteJournalContainerVM | null;
}

/**
 * One ROUND TRIP (model turn) in a NaniteJournal's execution trace — the
 * top-level unit of the grouped Execution view. `narration` is the assistant's
 * text for that turn (shown expanded); `toolSteps` are the tool calls it made
 * that turn (each individually collapsible). Structural mirror of
 * `NaniteJournalRoundVM` in `src/webview/documentEditorProvider.ts`.
 */
export interface NaniteJournalRoundVM {
  /** The model-turn index this round represents (1-based when known). */
  round: number;
  /** The assistant narration for this round (may be empty). */
  narration: string;
  /** The tool calls the model made in this round (individually expandable). */
  toolSteps: NaniteJournalStepVM[];
}

/** The acceptance-judge verdict rendered on a NaniteJournal detail view. */
export interface NaniteJournalAcceptanceVM {
  summary: string;
  confidence: number;
  threshold: number;
  passed: boolean;
}

/**
 * The single top-of-body callout on a NaniteJournal detail view. Consolidates
 * the former run-error banner + separate acceptance card into one treatment.
 * Structural mirror of `NaniteJournalCalloutVM` in
 * `src/webview/documentEditorProvider.ts`.
 */
export interface NaniteJournalCalloutVM {
  /** Visual variant: acceptance verdict, or a plain run-error banner. */
  variant: 'accepted' | 'rejected' | 'failed';
  /** Headline verdict text ("Accepted" | "Rejected"); empty for 'failed'. */
  verdict: string;
  /** "confidence X · threshold Y" for acceptance variants; empty otherwise. */
  score: string;
  /** Body text — the acceptance summary (reason), or the run's error message. */
  reason: string;
}

/**
 * The dedicated NaniteJournal detail view-model — ONE immutable record of a
 * single nanite run, surfaced when a `NaniteJournal` document is focused. Built
 * host-side by `projectNaniteJournalDetail` and carried on {@link GenericDocVM}
 * (`naniteJournal`) so the generic editor can branch to a bespoke layout while
 * keeping the shared document envelope (title / kind badge / timestamps).
 * Structural mirror of `NaniteJournalDetailVM` in
 * `src/webview/documentEditorProvider.ts`.
 */
/**
 * One parsed segment of a journal prompt: literal `text`, or a document-sourced
 * `block` extracted from a `// START BLOCK <route>#<field>?v<version>` …
 * `// END BLOCK` span. Mirror of `PromptSegmentVM` in
 * `src/webview/documentEditorProvider.ts`.
 */
export type PromptSegmentVM =
  | { kind: 'text'; text: string }
  | { kind: 'block'; route: string; field: string; version: string; content: string };

export interface NaniteJournalDetailVM {
  /** Terminal outcome (null ⇒ still running/unknown). */
  outcome: 'succeeded' | 'failed' | null;
  /** Lifecycle phase text (Succeeded / Failed / Running / …). */
  phase: string;
  /** Unix seconds the run was enqueued (0 when unknown). */
  queuedAt: number;
  /** Unix seconds the run started (0 when unknown). */
  startedAt: number;
  /** Unix seconds the run ended (0 when unknown). */
  endedAt: number;
  /** Human run duration (e.g. "2.3s", "1m 4s"), or '' when unknown. */
  duration: string;
  /** The full request text sent to the model that run. */
  request: string;
  /**
   * The `request` parsed into ordered segments: plain text, or a
   * document-sourced block the view renders as a collapsible link-out. Mirror
   * of `PromptSegmentVM` in `src/webview/documentEditorProvider.ts`.
   */
  promptSegments: PromptSegmentVM[];
  /** The ordered execution trace (assistant + tool steps). */
  steps: NaniteJournalStepVM[];
  /** The execution trace grouped into ordered round trips (model turns). */
  rounds: NaniteJournalRoundVM[];
  /** The run's failure message (empty when it didn't error). */
  error: string;
  /** Plain-language summary of what the run did. */
  summary: string;
  /** The acceptance-judge verdict, or null when never judged. */
  acceptance: NaniteJournalAcceptanceVM | null;
  /** The single top callout (null ⇒ nothing to flag). */
  callout: NaniteJournalCalloutVM | null;
  /** Link-out to the owning Nanite. */
  nanite: NaniteJournalLinkVM;
  /** Link-out to the owning NaniteTemplate (id empty when none). */
  template: NaniteJournalLinkVM;
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
  /** For a Nanite doc: its run history (newest-first). Absent for other kinds. */
  journals?: NaniteJournalRowVM[];
  /**
   * For a `NaniteJournal` doc: the dedicated run-record detail. Present only for
   * that kind, so the generic view branches to the bespoke journal layout.
   */
  naniteJournal?: NaniteJournalDetailVM;
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
  | { type: 'staleReload' }
  // ---- Right-rail command widget (WM 14.2.1) --------------------------------
  // The sticky-context slug (currently/last-selected WM doc), pushed so the
  // command box can show + default its scope.
  | { type: 'context'; slug: string | null; kind: string | null }
  // The agentic tool-calling loop started running for the submitted command.
  // `scope` is the run's scope key — the webview drops the message if the user
  // has since switched to a different scope (mid-run scope-display guard).
  | { type: 'briefRunning'; scope: string }
  // The loop finished: a markdown brief of what was done + the tool-call trail.
  | { type: 'brief'; markdown: string; scope: string }
  // The command could not run (control plane down, transport error, …).
  | { type: 'briefError'; message: string; scope: string }
  // Replay a scope's persisted CommandJournal chat: replaces the in-memory
  // transcript with these turns (oldest→newest) on load / scope-change. Each
  // turn carries the CommandJournal doc `id` so its bubbles can open the record.
  | { type: 'hydrate'; turns: { id: string; command: string; brief: string }[] }
  // Tag the just-completed live turn with its freshly-created CommandJournal doc
  // id, so it's right-click-openable without waiting for a reload/hydrate.
  // `scope` guards against tagging a turn that's no longer displayed.
  | { type: 'attachJournalId'; id: string; scope: string };

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
  // Open a document by its working-memory route, parsed from a journal prompt
  // block marker's link-out (`/document/<id>.working-memory` or
  // `/topic/<slug>.working-memory`).
  | { type: 'openRoute'; route: string }
  | { type: 'invoke'; command: string; args: unknown[] }
  | { type: 'togglePinTopic'; slug: string }
  // Transition an alert's lifecycle status (resolve / escalate / close / reopen)
  // from a callout button. Routed to `ws-alert-update` via the control-plane
  // client; the live-refresh then re-pushes the updated callouts.
  | { type: 'setAlertStatus'; id: string; status: 'alert' | 'informational' | 'closed' }
  // Reports whether the webview currently holds un-flushed local edits so the
  // host's refresh decision won't stomp in-progress work (Bug A).
  | { type: 'editState'; hasPendingEdits: boolean }
  // The user clicked the reload banner: discard local edits + take the server
  // version.
  | { type: 'discardAndReload' }
  // ---- Right-rail command widget (WM 14.2.1) --------------------------------
  // Run a natural-language command through the local-model tool-calling loop,
  // scoped to the sticky-context slug (or null when nothing is selected).
  | { type: 'submitCommand'; command: string; contextSlug: string | null }
  // Open a transcript entry's underlying CommandJournal record in working-memory's
  // generic document view (right-click → "Open CommandJournal record").
  | { type: 'openJournal'; id: string };
