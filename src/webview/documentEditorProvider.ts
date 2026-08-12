import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import type {
  ControlPlaneClient,
  DocumentEnvelope,
  Alert,
  Nanite,
  NaniteJournal,
  NaniteTemplate,
  Topic,
  TopicType,
  Workstream,
} from '../controlPlaneClient';
import {
  buildWorkstreamTree,
  type PanelAction,
  type PanelNaniteRow,
  type PanelTopic,
  type PanelTopicsGroup,
} from '../panelData';
import { decideRefreshAction } from './refreshDecision';
import { buildAlertVMs, RECENT_CLOSED_ALERT_MS, alertBubbleForTopic } from './alertVms';

/**
 * The unified Working Memory document custom editor (WM 14.2
 * "svelte-document-editor").
 *
 * The control plane is a GENERIC document store, so there is ONE custom editor —
 * not one per kind. VS Code is URI-addressed, not disk-addressed: a "document
 * file" is a synthetic virtual URI
 * `working-memory:/<kind>/<slug-or-id>.working-memory`. The `.working-memory`
 * extension makes the `customEditors` `filenamePattern` match; the
 * `working-memory` FileSystemProvider stats it as a zero-byte handle so
 * `vscode.openWith` resolves. There is NO file on disk and NO DB access —
 * `resolveCustomEditor` loads the document THROUGH THE CONTROL-PLANE CLIENT and
 * pushes a view-model to a Svelte webview, which dispatches its UI by `kind`
 * (workstream / topic / a generic fallback for every other kind).
 *
 * Save model is autosave: an editable field posts a debounced patch, persisted
 * via the typed control-plane update methods (`ws-workstream-update` /
 * `ws-topic-update`), which echoes the refreshed view-model back. No dirty
 * state, so the CustomDocument edit/save/revert hooks are inert.
 */

// ---- View-models (structural mirror of `webview-ui/src/lib/types.ts`) --------

interface WorkstreamTopicVM {
  title: string;
  slug: string;
  status: string;
  pinned: boolean;
}

interface TreeActionVM {
  command: string;
  title: string;
  icon: string;
  args: unknown[];
  enabled: boolean;
}

interface TreeNaniteVM {
  kind: 'nanite';
  id: string;
  label: string;
  icon: string;
  phase: string;
  openId: string;
  actions: TreeActionVM[];
}

interface TreeTopicVM {
  kind: 'topic';
  id: string;
  label: string;
  icon: string;
  status: string;
  slug: string;
  pinned: boolean;
  alertCount: number;
  alertSeverity: 'alert' | 'informational' | null;
  children: Array<TreeTopicVM | TreeNaniteVM>;
  actions: TreeActionVM[];
}

interface TreeGroupVM {
  kind: 'group';
  id: string;
  label: string;
  icon: string;
  children: Array<TreeTopicVM | TreeNaniteVM>;
}

interface WorkstreamVM {
  kind: 'workstream';
  title: string;
  slug: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  closure: string | null;
  resourceVersion: number;
  editable: boolean;
  topics: WorkstreamTopicVM[];
  tree: TreeGroupVM[];
  alerts: AlertVM[];
}

interface RelationVM {
  slug: string;
  title: string;
  alertCount: number;
  alertSeverity: 'alert' | 'informational' | null;
}

interface AlertVM {
  id: string;
  title: string;
  description: string;
  recommendedAction: string;
  status: 'alert' | 'informational' | 'closed';
  updatedAt: number;
  dimmed: boolean;
}

interface TopicTypeMetaVM {
  slug: string | null;
  label: string;
  icon: string;
  description: string;
}

interface TopicVM {
  kind: 'topic';
  title: string;
  slug: string | null;
  status: string;
  topicType: string;
  typeMeta: TopicTypeMetaVM | null;
  body: string;
  createdAt: number;
  updatedAt: number;
  resourceVersion: number;
  editable: boolean;
  parents: RelationVM[];
  children: RelationVM[];
  workstreams: RelationVM[];
  focusedWorkstreams: RelationVM[];
  alerts: AlertVM[];
}

interface GenericFieldVM {
  key: string;
  value: string;
}

/**
 * One row in a Nanite doc's run-history list (its {@link NaniteJournal}s),
 * rendered at the bottom of the nanite page styled like a workstream card's
 * topic rows. Structural mirror of `NaniteJournalRowVM` in
 * `webview-ui/src/lib/types.ts`.
 */
interface NaniteJournalRowVM {
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
 * Nanite or its NaniteTemplate). Structural mirror of `NaniteJournalLinkVM` in
 * `webview-ui/src/lib/types.ts`.
 */
interface NaniteJournalLinkVM {
  /** Document id used to open it (empty ⇒ unresolved, link hidden). */
  id: string;
  /** Friendly label for the link. */
  title: string;
}

/**
 * One linked item in a multi-result {@link FriendlyReadVM} (list mode). Each
 * item renders as its own clickable link that opens the underlying document via
 * the panel's `onOpenRoute`. Structural mirror of `FriendlyReadItemVM` in
 * `webview-ui/src/lib/types.ts`.
 */
interface FriendlyReadItemVM {
  /** Human label (title → name → slug → id), truncated. */
  label: string;
  /** working-memory route to open the item (`/topic/<slug>.working-memory`, …). */
  route: string;
}

/**
 * A friendly summary of a Working-Memory document-READ tool step, derived from
 * the step's parsed `result`/`input` (see {@link friendlyReadStep}). When
 * present, the Execution trace renders a clickable one-line summary instead of
 * raw JSON, while the raw INPUT/RESULT stay available on the step's disclosure.
 *
 * Discriminated by `mode`:
 * - `'single'` — a by-slug/id or count-1 read; renders `read <tool>
 *   [<label> (v<version>)]`. `label`/`version`/`route` carry the item; the list
 *   fields are empty (`scope: ''`, `items: []`, `moreCount: 0`).
 * - `'list'`  — a multi-item read; renders `read <tool> <scope> → [A] [B] …`.
 *   `scope` is the leading input-derived text (workstream slug / query, may be
 *   `''`), `items` the linked results (capped), `moreCount` the overflow count;
 *   the single fields are empty (`label: ''`, `version: 0`, `route: ''`).
 *
 * Fields are kept non-optional (with empty sentinels for the unused mode) so
 * the webview↔host contract-parity guard stays a plain field-name comparison.
 * Structural mirror of `FriendlyReadVM` in `webview-ui/src/lib/types.ts`.
 */
interface FriendlyReadVM {
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
 * of `NaniteJournalContainerVM` in `webview-ui/src/lib/types.ts`. Fields use
 * empty-string sentinels (never optional) so the contract-parity guard stays a
 * plain field-name comparison; `host` empty ⇒ render the label as plain text.
 */
interface NaniteJournalContainerVM {
  /** The run's container id (the `wm-nanite` id-label value). */
  id: string;
  /** OrbStack per-container name (empty when unresolved). */
  name: string;
  /** `<name>.orb.local` host (empty when unresolved) — a clickable https link. */
  host: string;
}

/**
 * One step in a NaniteJournal's execution trace. Structural mirror of
 * `NaniteJournalStepVM` in `webview-ui/src/lib/types.ts`.
 */
interface NaniteJournalStepVM {
  kind: 'assistant' | 'tool';
  label: string;
  ok: boolean | null;
  text: string;
  input: string;
  result: string;
  error: string;
  /** Friendly WM-read summary (null ⇒ render the raw step). */
  friendly: FriendlyReadVM | null;
  /** The dev container this step ran inside (null ⇒ not container-backed). */
  container: NaniteJournalContainerVM | null;
}

/**
 * One ROUND TRIP (model turn) in a NaniteJournal's execution trace. Top-level
 * unit of the grouped Execution view: the assistant's `narration` for that turn
 * (shown expanded) plus the `toolSteps` it made that turn (each individually
 * collapsible). Structural mirror of `NaniteJournalRoundVM` in
 * `webview-ui/src/lib/types.ts`.
 */
interface NaniteJournalRoundVM {
  /** The model-turn index this round represents (1-based when known). */
  round: number;
  /** The assistant narration for this round (may be empty). */
  narration: string;
  /** The tool calls the model made in this round (individually expandable). */
  toolSteps: NaniteJournalStepVM[];
}

/** The acceptance verdict on a journal detail. Mirror of the webview VM. */
interface NaniteJournalAcceptanceVM {
  summary: string;
  confidence: number;
  threshold: number;
  passed: boolean;
}

/**
 * The single top-of-body callout descriptor. Consolidates what used to be two
 * redundant treatments (a run-error banner + a separate acceptance card) into
 * one: an accepted/rejected acceptance verdict, or — when the run was never
 * judged — the run's error, or null when there's nothing to flag. Mirror of the
 * webview VM.
 */
interface NaniteJournalCalloutVM {
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
 * The dedicated NaniteJournal detail view-model. Structural mirror of
 * `NaniteJournalDetailVM` in `webview-ui/src/lib/types.ts`.
 */
interface NaniteJournalDetailVM {
  outcome: 'succeeded' | 'failed' | null;
  phase: string;
  queuedAt: number;
  startedAt: number;
  endedAt: number;
  duration: string;
  request: string;
  /**
   * The `request` parsed into ordered segments: plain text, or a
   * document-sourced block (a `// START BLOCK … // END BLOCK` span) the view
   * renders as a collapsible link-out to its source.
   */
  promptSegments: PromptSegmentVM[];
  steps: NaniteJournalStepVM[];
  /** The execution trace grouped into ordered round trips (model turns). */
  rounds: NaniteJournalRoundVM[];
  error: string;
  summary: string;
  acceptance: NaniteJournalAcceptanceVM | null;
  /** The single top callout (null ⇒ nothing to flag). */
  callout: NaniteJournalCalloutVM | null;
  nanite: NaniteJournalLinkVM;
  template: NaniteJournalLinkVM;
}

interface GenericDocVM {
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
  /** For a `NaniteJournal` doc: the dedicated run-record detail. */
  naniteJournal?: NaniteJournalDetailVM;
}

type DocumentVM = WorkstreamVM | TopicVM | GenericDocVM;

interface TopicPatch {
  title?: string;
  status?: string;
  body?: string;
}

type WebviewToExt =
  | { type: 'ready' }
  | { type: 'save'; patch: { title?: string; status?: string } }
  | { type: 'saveTopic'; patch: TopicPatch }
  | { type: 'openTopic'; slug: string }
  | { type: 'openWorkstream'; slug: string }
  | { type: 'openDocument'; id: string }
  // Open a document by its working-memory route (`/document/<id>.working-memory`
  // or `/topic/<slug>.working-memory`), parsed from a journal prompt block
  // marker's link-out.
  | { type: 'openRoute'; route: string }
  // Open an external URL in the default browser (e.g. a container's OrbStack
  // `<name>.orb.local` https host, which is not a working-memory route).
  | { type: 'openExternal'; url: string }
  | { type: 'invoke'; command: string; args: unknown[] }
  | { type: 'togglePinTopic'; slug: string }
  // Transition an alert's lifecycle status from a callout button, routed to
  // `ws-alert-update` via the control-plane client.
  | { type: 'setAlertStatus'; id: string; status: 'alert' | 'informational' | 'closed' }
  // The webview reports whether it currently holds un-flushed local edits so the
  // host's refresh decision can avoid stomping in-progress work (Bug A).
  | { type: 'editState'; hasPendingEdits: boolean }
  // The user clicked the "content changed — reload" banner: discard local edits
  // and re-push the current server version.
  | { type: 'discardAndReload' };

type ExtToWebview =
  | { type: 'document'; data: DocumentVM }
  | { type: 'saved'; resourceVersion?: number }
  | { type: 'error'; message: string }
  // Non-terminal startup state: the control plane isn't connected yet, so the
  // webview shows "connecting…" and waits for a refresh to heal it (Bug B).
  | { type: 'connecting' }
  // A newer server version exists but the user has unsaved edits — the webview
  // surfaces a reload affordance instead of overwriting (Bug A).
  | { type: 'staleReload' };

/** Outcome of loading a document: distinguishes "not ready" from a genuine 404. */
type LoadOutcome =
  | { status: 'ok'; vm: DocumentVM }
  | { status: 'notFound' }
  | { status: 'notReady'; message?: string };

/**
 * Per-open-editor state the provider tracks so it can re-fetch + re-push each
 * live webview when the store changes out-of-process (Bug A) and heal editors
 * that failed their first load because the daemon wasn't up yet (Bug B).
 */
interface OpenEditorEntry {
  ref: ParsedRef;
  post: (msg: ExtToWebview) => void;
  /** The `hashVm` of the view-model currently displayed, or null when unloaded. */
  loadedSignal: string | null;
  /** True while showing an error / connecting state or not yet loaded. */
  errored: boolean;
  /** True while the webview holds un-flushed local edits. */
  hasPendingEdits: boolean;
  /**
   * Whether this editor's panel is currently visible. Hidden editors are
   * skipped by `refreshOpen()` and revalidated when they become visible again.
   */
  visible: boolean;
}

/** The parsed kind hint + identifier from a `.working-memory` URI. */
interface ParsedRef {
  /** URI kind hint: 'workstream' | 'topic' | 'document' | any other kind name. */
  kindHint: string;
  /** Slug or id captured from the URI. */
  identifier: string;
}

/** Minimal custom document: the URI + parsed kind hint / identifier. */
interface WmDocument extends vscode.CustomDocument {
  readonly ref: ParsedRef;
}

/** Parse `working-memory:/<kind>/<x>.working-memory` into a kind hint + id. */
export function parseRef(uri: vscode.Uri): ParsedRef {
  const match = /^\/([^/]+)\/(.+)\.working-memory$/.exec(uri.path);
  if (!match) {
    return { kindHint: 'document', identifier: uri.path };
  }
  const kindHint = match[1];
  let identifier = match[2];
  try {
    identifier = decodeURIComponent(identifier);
  } catch {
    // keep raw
  }
  return { kindHint, identifier };
}

/** Map a URI kind hint to the control-plane document `kind` name. */
export function controlPlaneKindFor(kindHint: string): string | null {
  switch (kindHint) {
    case 'workstream':
      return 'Workstream';
    case 'topic':
      return 'Topic';
    case 'topic-type':
      return 'TopicType';
    case 'alert':
      return 'Alert';
    case 'document':
      return null; // generic by-id lookup, any kind
    default:
      // A capitalized kind name passed straight through (e.g. 'Nanite').
      return kindHint;
  }
}

function makeNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Extract a human-readable message from an unknown thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Decide whether toggling a topic's pin in this workstream should SET focus
 * (true) or CLEAR it (false): set when the workstream isn't already in the
 * topic's `focusedWorkstreams`. Pure so the toggle decision is unit-testable.
 */
export function shouldSetFocus(
  focusedWorkstreams: readonly string[],
  wsSlug: string,
): boolean {
  return !focusedWorkstreams.includes(wsSlug);
}

/** Nanite lifecycle commands the tree may invoke on the host (allow-list). */
const NANITE_TREE_COMMANDS = new Set([
  'workingMemory.nanite.run',
  'workingMemory.nanite.reset',
  'workingMemory.nanite.restart',
]);

/** Bounded backoff for the initial "connecting…" retry on first load (Bug B). */
const LOAD_RETRY_LIMIT = 5;
const LOAD_RETRY_DELAY_MS = 600;

/** Best-effort string coercion for a `spec` value. */
export function asString(v: unknown): string {
  if (v === null || v === undefined) {
    return '';
  }
  if (typeof v === 'string') {
    return v;
  }
  return typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
}

/**
 * Legacy run-result keys that used to live on a Nanite `spec` before the run
 * record was split out into its own immutable `NaniteJournal` (feature
 * `nanite-run-journal-document`). New nanites never carry these, but nanites
 * created before the split still do — so the generic doc view filters them out,
 * leaving only the nanite's DESIRED STATE (request, configs, template, scope,
 * phase/timings). Run history now lives in the journal list at the bottom of
 * the nanite page.
 */
const NANITE_RUN_REMNANT_KEYS = new Set([
  'prompt',
  'output',
  'steps',
  'acceptance',
  'toolCalls',
  'tokens',
  'missingTools',
  'iterations',
  'hitIterationCap',
]);

/**
 * Build the generic fallback view-model from a document envelope: flatten +
 * sort the `spec` into readable fields and derive a title. Pure — no client,
 * no VS Code APIs — so it can be unit-tested directly. For a `Nanite` doc the
 * legacy run-result keys ({@link NANITE_RUN_REMNANT_KEYS}) are dropped so the
 * view shows only desired state; the run record lives in its NaniteJournal.
 */
export function buildGenericVM(doc: DocumentEnvelope): GenericDocVM {
  const isNanite = doc.kind === 'Nanite';
  const spec: GenericFieldVM[] = Object.entries(doc.spec ?? {})
    .filter(([key]) => !(isNanite && NANITE_RUN_REMNANT_KEYS.has(key)))
    .map(([key, value]) => ({ key, value: asString(value) }));
  spec.sort((a, b) => a.key.localeCompare(b.key));
  const title =
    asString(doc.spec?.title) ||
    asString(doc.spec?.label) ||
    doc.metadata.slug ||
    doc.metadata.id;
  return {
    kind: doc.kind,
    id: doc.metadata.id,
    slug: doc.metadata.slug,
    title,
    createdAt: doc.metadata.createdAt,
    updatedAt: doc.metadata.updatedAt,
    resourceVersion: doc.metadata.resourceVersion,
    spec,
  };
}

/** Clip a summary/error to one readable line for a journal row. */
function clipSummary(text: string, max = 140): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/** Format a run duration (seconds → "2.3s" / "1m 4s"); '' when unknown. */
function formatDuration(startedAt: number | null, endedAt: number | null): string {
  if (!startedAt || !endedAt || endedAt < startedAt) {
    return '';
  }
  const secs = endedAt - startedAt;
  if (secs < 60) {
    return `${secs}s`;
  }
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Project a nanite's {@link NaniteJournal} records into the run-history rows
 * rendered at the bottom of its doc page — NEWEST-FIRST (by end time, falling
 * back to start time then created-at). Pure so the ordering + row shaping are
 * unit-testable. Each row's summary is the run's result summary, or its error
 * on a failed run with no summary.
 */
export function projectNaniteJournals(journals: NaniteJournal[]): NaniteJournalRowVM[] {
  const sortKey = (j: NaniteJournal): number =>
    j.status.endedAt ?? j.status.startedAt ?? j.created_at ?? 0;
  return [...journals]
    .sort((a, b) => sortKey(b) - sortKey(a))
    .map((j) => {
      const summary = j.results.summary.trim() || j.execution.error.trim();
      return {
        id: j.id,
        outcome: j.status.outcome,
        phase: j.status.phase,
        summary: clipSummary(summary),
        endedAt: j.status.endedAt ?? 0,
        duration: formatDuration(j.status.startedAt, j.status.endedAt),
      };
    });
}

/** Friendly label for a nanite link-out (its request, else a short id). */
function naniteLinkTitle(naniteId: string, nanite: Nanite | null): string {
  const request = nanite?.request.trim() ?? '';
  if (request) {
    return clipSummary(request, 80);
  }
  return `Nanite ${naniteId.slice(0, 8)}`;
}

/**
 * Choose the SINGLE top-of-body callout for a journal, collapsing the former
 * pair of redundant treatments (a run-error banner + a low acceptance card)
 * into one. An acceptance verdict wins when present — its `summary` becomes the
 * reason and the confidence/threshold the score, so a rejection reads fully at
 * the top with no duplicate low card. With no verdict we fall back to the run's
 * error (the run outcome, as before); a clean run yields `null` (no callout).
 * Pure so the choice is unit-testable.
 */
export function naniteJournalCallout(
  acceptance: NaniteJournalAcceptanceVM | null,
  error: string,
): NaniteJournalCalloutVM | null {
  if (acceptance) {
    return {
      variant: acceptance.passed ? 'accepted' : 'rejected',
      verdict: acceptance.passed ? 'Accepted' : 'Rejected',
      score: `confidence ${acceptance.confidence} · threshold ${acceptance.threshold}`,
      reason: acceptance.summary,
    };
  }
  if (error) {
    return { variant: 'failed', verdict: '', score: '', reason: error };
  }
  return null;
}

/**
 * One parsed segment of a journal prompt: literal `text`, or a document-sourced
 * `block` extracted from a `// START BLOCK <route>#<field>?v<version>` …
 * `// END BLOCK` span. Structural mirror of `PromptSegmentVM` in
 * `webview-ui/src/lib/types.ts`.
 */
export type PromptSegmentVM =
  | { kind: 'text'; text: string }
  | { kind: 'block'; route: string; field: string; version: string; content: string };

/** Push a text segment, trimming outer blank lines + dropping empty / separator-only runs. */
function pushPromptText(segments: PromptSegmentVM[], raw: string): void {
  const text = raw.replace(/^\n+/, '').replace(/\n+$/, '');
  const trimmed = text.trim();
  if (!trimmed || /^-{3,}$/.test(trimmed)) {
    return;
  }
  segments.push({ kind: 'text', text });
}

/**
 * Parse `// START BLOCK <route>#<field>?v<version>` … `// END BLOCK` spans out of
 * a journal prompt into an ordered list of segments. Well-formed spans become
 * `block` segments (rendered as link-outs); everything else — including a
 * malformed or unclosed marker — stays as literal `text`, so a bad marker
 * degrades to raw text instead of crashing the view. Pure + string-only, so the
 * parsing is unit-testable.
 */
export function parsePromptBlocks(request: string): PromptSegmentVM[] {
  const segments: PromptSegmentVM[] = [];
  const re = /\/\/ START BLOCK ([^#\s]+)#([^?\s]+)\?v([^\s]+)\n([\s\S]*?)\n\/\/ END BLOCK/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(request)) !== null) {
    if (m.index > last) {
      pushPromptText(segments, request.slice(last, m.index));
    }
    segments.push({ kind: 'block', route: m[1], field: m[2], version: m[3], content: m[4] });
    last = m.index + m[0].length;
  }
  if (last < request.length) {
    pushPromptText(segments, request.slice(last));
  }
  if (segments.length === 0) {
    segments.push({ kind: 'text', text: request });
  }
  return segments;
}

/**
 * Working-Memory document-READ tool names whose `{ count, <plural>: [...] }`
 * results can be summarized into a friendly clickable line.
 */
const WM_READ_TOOLS = new Set([
  'ws-topic-read',
  'ws-workstream-read',
  'ws-topictype-read',
  'ws-config-read',
  'ws-alert-read',
  'ws-nanite-read',
  'ws-nanitejournal-read',
]);

/** The two slug-addressable read tools; every other WM read opens by document id. */
const WM_READ_SLUG_ROUTE: Record<string, 'topic' | 'workstream'> = {
  'ws-topic-read': 'topic',
  'ws-workstream-read': 'workstream',
};

/** Max inline links shown for a list read before collapsing into "+K more". */
const WM_READ_LIST_CAP = 6;

/**
 * Derive the leading scope text for a list read from the step's INPUT JSON:
 * prefer the `workstream` slug, else the `query`, else `''`. Never throws.
 */
function friendlyReadScope(input?: string): string {
  if (typeof input !== 'string' || input.trim() === '') {
    return '';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object') {
    return '';
  }
  const obj = parsed as Record<string, unknown>;
  const ws = typeof obj.workstream === 'string' ? obj.workstream.trim() : '';
  if (ws) {
    return ws;
  }
  const query = typeof obj.query === 'string' ? obj.query.trim() : '';
  return query || '';
}

/**
 * Project one raw result item into `{ label, route, version }`, deriving the
 * label (title → name → slug → id) and a working-memory route (`/topic/<slug>`
 * or `/workstream/<slug>`, else `/document/<id>`). Returns `null` when the item
 * has no usable label or no addressable route. `version` is `0` when absent.
 */
function friendlyReadItem(
  raw: unknown,
  slugKind: 'topic' | 'workstream' | undefined,
): { label: string; route: string; version: number } | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === 'string' ? item.id : '';
  const slug = typeof item.slug === 'string' ? item.slug : '';
  const title = typeof item.title === 'string' ? item.title.trim() : '';
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const rawLabel = title || name || slug || id;
  if (!rawLabel) {
    return null;
  }
  const route =
    slugKind && slug
      ? `/${slugKind}/${encodeURIComponent(slug)}.working-memory`
      : id
        ? `/document/${encodeURIComponent(id)}.working-memory`
        : '';
  if (!route) {
    return null;
  }
  const version = typeof item.resourceVersion === 'number' ? item.resourceVersion : 0;
  return { label: rawLabel, route, version };
}

/**
 * Build a {@link FriendlyReadVM} from an already-extracted item array. Shared by
 * the digest path (preferred) and the raw-JSON fallback. `totalCount` is the
 * TRUE result total (the digest's `count`, or the array length for the fallback)
 * so `moreCount` reflects results omitted beyond both the storage + display cap.
 * Returns `null` for an empty list or an unaddressable single item.
 */
function friendlyReadFromItems(
  tool: string,
  slugKind: 'topic' | 'workstream' | undefined,
  rawItems: unknown[],
  input: string | undefined,
  totalCount: number,
): FriendlyReadVM | null {
  if (rawItems.length === 0) {
    return null;
  }

  // Single-item read keeps the versioned single form (requires resourceVersion).
  if (totalCount === 1 && rawItems.length === 1) {
    const built = friendlyReadItem(rawItems[0], slugKind);
    if (!built || typeof (rawItems[0] as Record<string, unknown>).resourceVersion !== 'number') {
      return null;
    }
    return {
      verb: 'read',
      tool,
      mode: 'single',
      label: clipSummary(built.label, 60),
      version: built.version,
      route: built.route,
      scope: '',
      items: [],
      moreCount: 0,
    };
  }

  // Multi-item read → scope + one link per result, capped for readability.
  const built = rawItems
    .map((raw) => friendlyReadItem(raw, slugKind))
    .filter((x): x is { label: string; route: string; version: number } => x !== null);
  if (built.length === 0) {
    return null;
  }
  const shown = built.slice(0, WM_READ_LIST_CAP);
  return {
    verb: 'read',
    tool,
    mode: 'list',
    label: '',
    version: 0,
    route: '',
    scope: friendlyReadScope(input),
    items: shown.map((b) => ({ label: clipSummary(b.label, 40), route: b.route })),
    moreCount: Math.max(0, totalCount - shown.length),
  };
}

/**
 * Try to summarize a WM document-READ tool step into a friendly, clickable
 * line. Recognizes the WM read tools ({@link WM_READ_TOOLS}) and prefers the
 * step's compact, body-free {@link FriendlyReadVM} source in priority order:
 *
 * 1. `resultDigest` (PREFERRED) — the runner captures this from the FULL result
 *    before truncation, so it is complete + never depends on the (possibly
 *    truncated) `result` string. Its `count` drives `moreCount`.
 * 2. `result` JSON (FALLBACK) — for older, pre-digest journals: parse the
 *    (possibly truncated) `result` best-effort as `{ count, <plural>: [...] }`
 *    and take the first array-valued property as the items.
 *
 * - A **single-item** result yields a `mode: 'single'` VM with the item's label
 *   (truncated) + `resourceVersion` + route — the versioned form.
 * - A **multi-item** result yields a `mode: 'list'` VM: a `scope` derived from
 *   the step's INPUT (workstream slug / query), each item as its own linked
 *   `{ label, route }` (labels truncated, versions omitted to stay uncluttered),
 *   capped at {@link WM_READ_LIST_CAP} with the overflow in `moreCount`.
 *
 * Returns `null` for a non-WM step, a non-tool step, an empty result, or any
 * malformed/unparseable input so the caller falls back to the raw rendering.
 * Pure + string-only, so it is unit-testable and never throws.
 */
export function friendlyReadStep(step: {
  kind?: string;
  name?: string;
  input?: string;
  result?: string;
  resultDigest?: { count?: number; items?: unknown[] } | null;
}): FriendlyReadVM | null {
  if (step.kind !== 'tool') {
    return null;
  }
  const tool = (step.name ?? '').trim();
  if (!WM_READ_TOOLS.has(tool)) {
    return null;
  }
  const slugKind = WM_READ_SLUG_ROUTE[tool];

  // PREFERRED: render from the body-free digest captured at record time.
  const digest = step.resultDigest;
  if (digest && Array.isArray(digest.items) && digest.items.length > 0) {
    const total = typeof digest.count === 'number' ? digest.count : digest.items.length;
    return friendlyReadFromItems(tool, slugKind, digest.items, step.input, total);
  }

  // FALLBACK: best-effort parse of the raw (possibly truncated) result JSON so
  // pre-digest journals still render when their result happened to fit.
  if (typeof step.result !== 'string' || step.result.trim() === '') {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(step.result);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }
  // The item list is the first array-valued property (`topics` / `workstreams`
  // / `alerts` / …); taking it by shape avoids hard-coding each plural key.
  const rawItems = Object.values(parsed as Record<string, unknown>).find((v) => Array.isArray(v)) as
    | unknown[]
    | undefined;
  if (!rawItems || rawItems.length === 0) {
    return null;
  }
  return friendlyReadFromItems(tool, slugKind, rawItems, step.input, rawItems.length);
}

/** The shape of a raw execution step read off a journal (round + kind + previews). */
type RawRunStep = {
  kind: 'assistant' | 'tool';
  round?: number;
  text?: string;
  name?: string;
  ok?: boolean;
  input?: string;
  result?: string;
  error?: string;
  /** Body-free digest of a WM read result (preferred source for `friendly`). */
  resultDigest?: { count?: number; items?: unknown[] } | null;
  /** Identity of the dev container a container-backed tool step ran inside. */
  container?: { id?: string; name?: string; host?: string } | null;
};

/**
 * Project a raw step's container identity into its VM. Returns null unless the
 * step carries a non-empty container `id` (only container-backed tool steps do).
 */
function containerToVM(
  c: { id?: string; name?: string; host?: string } | null | undefined,
): NaniteJournalContainerVM | null {
  if (!c || typeof c.id !== 'string' || c.id === '') {
    return null;
  }
  return {
    id: c.id,
    name: typeof c.name === 'string' ? c.name : '',
    host: typeof c.host === 'string' ? c.host : '',
  };
}

/** Project one raw execution step into its per-step disclosure VM. */
function stepToVM(s: RawRunStep): NaniteJournalStepVM {
  return {
    kind: s.kind,
    label: s.kind === 'tool' ? (s.name ?? '').trim() || 'tool' : 'Assistant',
    ok: s.kind === 'tool' ? s.ok ?? null : null,
    text: asString(s.text ?? ''),
    input: asString(s.input ?? ''),
    result: asString(s.result ?? ''),
    error: asString(s.error ?? ''),
    friendly: friendlyReadStep(s),
    container: containerToVM(s.container),
  };
}

/**
 * Group a flat execution trace into ordered ROUND TRIPS (model turns). Each
 * round carries the assistant `narration` for that turn (shown expanded in the
 * view) and the `toolSteps` made that turn (each individually collapsible).
 *
 * Pure and unit-tested. Two grouping strategies:
 *  - When steps carry a `round` index (the runner tags every step), group by it
 *    in first-seen order — the accurate path.
 *  - BACK-COMPAT: older journals predate `round`, so infer boundaries from the
 *    trace shape: an `assistant` step opens a new round and subsequent `tool`
 *    steps attach to it; leading tool steps before any narration form round 1.
 *
 * The number of returned rounds is what the Execution badge counts.
 */
export function groupStepsIntoRounds(steps: RawRunStep[]): NaniteJournalRoundVM[] {
  const hasRound = steps.some((s) => typeof s.round === 'number');

  if (hasRound) {
    const byRound = new Map<number, NaniteJournalRoundVM>();
    const order: number[] = [];
    for (const s of steps) {
      const idx = typeof s.round === 'number' ? s.round : 0;
      let round = byRound.get(idx);
      if (!round) {
        round = { round: idx, narration: '', toolSteps: [] };
        byRound.set(idx, round);
        order.push(idx);
      }
      if (s.kind === 'assistant') {
        const text = asString(s.text ?? '');
        round.narration = round.narration ? `${round.narration}\n\n${text}` : text;
      } else {
        round.toolSteps.push(stepToVM(s));
      }
    }
    return order.map((idx) => byRound.get(idx)!);
  }

  // Back-compat: no round tags → infer round trips from narration boundaries.
  const rounds: NaniteJournalRoundVM[] = [];
  let current: NaniteJournalRoundVM | null = null;
  let next = 1;
  for (const s of steps) {
    if (s.kind === 'assistant') {
      current = { round: next++, narration: asString(s.text ?? ''), toolSteps: [] };
      rounds.push(current);
    } else {
      if (!current) {
        current = { round: next++, narration: '', toolSteps: [] };
        rounds.push(current);
      }
      current.toolSteps.push(stepToVM(s));
    }
  }
  return rounds;
}

/**
 * Project ONE {@link NaniteJournal} into the dedicated run-record detail VM,
 * resolving link-outs to its owning {@link Nanite} (`nanite`) and that nanite's
 * {@link NaniteTemplate} (`template`). Both link-outs open by document id via
 * the panel's `/document/<id>` route; an unresolved reference yields an empty
 * `id` so the view hides the link. Pure — no client / VS Code APIs — so the
 * shaping is unit-testable. Each execution step is labelled assistant vs tool
 * (tool steps carry the tool name + ok/failed flag) with its input / result /
 * error kept for the webview's per-step disclosure.
 */
export function projectNaniteJournalDetail(
  journal: NaniteJournal,
  nanite: Nanite | null,
  template: NaniteTemplate | null,
): NaniteJournalDetailVM {
  const steps: NaniteJournalStepVM[] = journal.execution.steps.map(stepToVM);
  const rounds = groupStepsIntoRounds(journal.execution.steps);
  const acceptance = journal.results.acceptance;
  return {
    outcome: journal.status.outcome,
    phase: journal.status.phase,
    queuedAt: journal.status.queuedAt ?? 0,
    startedAt: journal.status.startedAt ?? 0,
    endedAt: journal.status.endedAt ?? 0,
    duration: formatDuration(journal.status.startedAt, journal.status.endedAt),
    request: journal.prompt.request,
    promptSegments: parsePromptBlocks(journal.prompt.request),
    steps,
    rounds,
    error: journal.execution.error,
    summary: journal.results.summary,
    acceptance: acceptance
      ? {
          summary: acceptance.summary,
          confidence: acceptance.confidence,
          threshold: acceptance.threshold,
          passed: acceptance.passed,
        }
      : null,
    callout: naniteJournalCallout(
      acceptance
        ? {
            summary: acceptance.summary,
            confidence: acceptance.confidence,
            threshold: acceptance.threshold,
            passed: acceptance.passed,
          }
        : null,
      journal.execution.error,
    ),
    nanite: {
      id: journal.naniteId,
      title: naniteLinkTitle(journal.naniteId, nanite),
    },
    template: {
      id: template?.id ?? '',
      title: template?.title ?? '',
    },
  };
}

/**
 * Host-side change-detection hash over an ENTIRE view-model. The workstream
 * screen is a COMPOSITE — it embeds its child topic + nanite tree — but the
 * workstream's own `resourceVersion` only moves when the workstream document
 * itself changes. Closing a child topic bumps the TOPIC's version, not the
 * workstream's, so a plain version compare misses it. Hashing the whole VM
 * (which includes that tree) catches every child-only change too, so no bespoke
 * composite fingerprint is needed. `JSON.stringify` is stable here: the VM is
 * built deterministically (sorted rows/tree) from the same inputs each fetch.
 */
export function hashVm(vm: DocumentVM): string {
  return JSON.stringify(vm);
}

/** Parse a topic slug out of a `working-memory:/topic/<slug>.working-memory` uri. */
function topicSlugFromUri(uri: string): string {
  const m = /^working-memory:\/topic\/(.+)\.working-memory$/.exec(uri);
  return m ? m[1] : '';
}

/** Parse a document id out of a `working-memory:/document/<id>.working-memory` uri. */
function documentIdFromUri(uri: string): string {
  const m = /^working-memory:\/document\/(.+)\.working-memory$/.exec(uri);
  return m ? m[1] : '';
}

/** Map a rail Panel topic/nanite row to the editor's minimal tree node VM. */
function toTreeNode(
  row: PanelTopic | PanelNaniteRow,
): TreeTopicVM | TreeNaniteVM {
  if (row.kind === 'nanite') {
    return {
      kind: 'nanite',
      id: row.id,
      label: row.label,
      icon: row.icon,
      phase: row.phase,
      openId: documentIdFromUri(row.openUri),
      actions: toTreeActions(row.actions),
    };
  }
  return {
    kind: 'topic',
    id: row.id,
    label: row.label,
    icon: row.icon,
    status: row.status,
    slug: topicSlugFromUri(row.openUri),
    pinned: row.focused,
    alertCount: row.alertCount ?? 0,
    alertSeverity: row.alertSeverity ?? null,
    children: (row.children ?? []).map(toTreeNode),
    actions: toTreeActions(row.actions),
  };
}

/** Map rail PanelAction[] to the tree's minimal action VMs (dropping description). */
function toTreeActions(actions: PanelAction[] | undefined): TreeActionVM[] {
  return (actions ?? []).map((a) => ({
    command: a.command,
    title: a.title,
    icon: a.icon ?? '',
    args: Array.isArray(a.args) ? a.args : [],
    enabled: a.enabled !== false,
  }));
}

/** Map a rail Panel topics-group to the editor's tree group VM. */
function toTreeGroup(group: PanelTopicsGroup): TreeGroupVM {
  return {
    kind: 'group',
    id: group.id,
    label: group.label,
    icon: group.icon,
    children: group.children.map(toTreeNode),
  };
}

export class DocumentEditorProvider
  implements vscode.CustomEditorProvider<WmDocument>
{
  public static readonly viewType = 'workingMemory.documentEditor';

  /** Build the virtual URI that opens a document of `kind` in this editor. */
  public static uriFor(kind: string, slugOrId: string): vscode.Uri {
    return vscode.Uri.parse(
      `working-memory:/${kind}/${encodeURIComponent(slugOrId)}.working-memory`,
    );
  }

  // Autosave-through-API means the document is never dirty, so this never fires.
  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<WmDocument>
  >();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  /**
   * Live registry of open webview panels so external store changes can re-fetch
   * + re-push each one (Bug A) and stuck "connecting" editors can self-heal once
   * the daemon comes up (Bug B). Cleared per-entry on `onDidDispose`.
   */
  private readonly openEditors = new Set<OpenEditorEntry>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly getClient: () => ControlPlaneClient | null,
  ) {}

  openCustomDocument(uri: vscode.Uri): WmDocument {
    return { uri, ref: parseRef(uri), dispose: () => undefined };
  }

  async resolveCustomEditor(
    document: WmDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    webview.html = this.renderHtml(webview);

    const post = (msg: ExtToWebview): void => {
      void webview.postMessage(msg);
    };

    // Register this panel so `refreshOpen()` can re-fetch + re-push it when the
    // store changes out-of-process, and heal it if the daemon wasn't up yet.
    const entry: OpenEditorEntry = {
      ref: document.ref,
      post,
      loadedSignal: null,
      errored: true,
      hasPendingEdits: false,
      visible: webviewPanel.visible,
    };
    this.openEditors.add(entry);
    webviewPanel.onDidDispose(() => {
      this.openEditors.delete(entry);
    });

    // Track panel visibility so `refreshOpen()` can skip hidden editors, and
    // revalidate an editor the moment it becomes visible again (hidden panels
    // don't get live store updates, so they'd otherwise show stale content).
    webviewPanel.onDidChangeViewState(() => {
      const wasVisible = entry.visible;
      entry.visible = webviewPanel.visible;
      if (!wasVisible && entry.visible) {
        void this.refreshEntry(entry);
      }
    });

    // Initial load with a short bounded backoff: if the control plane isn't
    // connected yet, show a NON-terminal "connecting…" state and retry a few
    // times. The primary heal is still the CP-ready `refresh()` → `refreshOpen()`
    // signal, but this covers the case where no store write follows startup.
    const load = async (attempt = 0): Promise<void> => {
      const outcome = await this.loadDocument(document.ref);
      if (outcome.status === 'ok') {
        this.pushDocument(entry, outcome.vm);
        return;
      }
      if (outcome.status === 'notFound') {
        entry.errored = true;
        entry.loadedSignal = null;
        post({
          type: 'error',
          message: `Document "${document.ref.identifier}" was not found.`,
        });
        return;
      }
      // notReady: daemon not connected yet — stay non-terminal and retry.
      entry.errored = true;
      entry.loadedSignal = null;
      post({ type: 'connecting' });
      if (attempt < LOAD_RETRY_LIMIT) {
        setTimeout(() => {
          if (this.openEditors.has(entry)) {
            void load(attempt + 1);
          }
        }, LOAD_RETRY_DELAY_MS);
      }
    };

    webview.onDidReceiveMessage(async (msg: WebviewToExt) => {
      if (!msg || typeof msg !== 'object') {
        return;
      }
      switch (msg.type) {
        case 'ready':
          await load();
          return;
        case 'openTopic':
          if (typeof msg.slug === 'string' && msg.slug.length > 0) {
            void vscode.commands.executeCommand('working-memory.open', {
              kind: 'topic',
              id: msg.slug,
            });
          }
          return;
        case 'openWorkstream':
          if (typeof msg.slug === 'string' && msg.slug.length > 0) {
            void vscode.commands.executeCommand('working-memory.open', {
              kind: 'workstream',
              id: msg.slug,
            });
          }
          return;
        case 'openDocument':
          // Nanites (and any generic doc) open straight through the unified
          // editor — `working-memory.open` whitelists only the named kinds, so
          // route the generic `document` kind via openWith like the rail does.
          if (typeof msg.id === 'string' && msg.id.length > 0) {
            void vscode.commands.executeCommand(
              'vscode.openWith',
              DocumentEditorProvider.uriFor('document', msg.id),
              DocumentEditorProvider.viewType,
            );
          }
          return;
        case 'openRoute':
          // A prompt-block link-out: open the referenced document straight
          // through the unified editor via its working-memory route. Validate
          // the shape so only well-formed `working-memory:` paths are parsed.
          if (
            typeof msg.route === 'string' &&
            msg.route.startsWith('/') &&
            msg.route.endsWith('.working-memory')
          ) {
            void vscode.commands.executeCommand(
              'vscode.openWith',
              vscode.Uri.parse(`working-memory:${msg.route}`),
              DocumentEditorProvider.viewType,
            );
          }
          return;
        case 'openExternal':
          // A container host link-out: open the https URL in the default
          // browser. Guard to https only so the webview can't drive the host
          // to open arbitrary schemes.
          if (typeof msg.url === 'string') {
            try {
              const uri = vscode.Uri.parse(msg.url, true);
              if (uri.scheme === 'https') {
                void vscode.env.openExternal(uri);
              }
            } catch {
              // Malformed URL — ignore.
            }
          }
          return;
        case 'save':
          await this.saveWorkstream(entry, msg.patch ?? {});
          return;
        case 'saveTopic':
          await this.saveTopic(entry, msg.patch ?? {});
          return;
        case 'editState':
          entry.hasPendingEdits = msg.hasPendingEdits === true;
          return;
        case 'discardAndReload':
          // The user chose to discard local edits and take the server version.
          entry.hasPendingEdits = false;
          await load();
          return;
        case 'invoke':
          // Nanite lifecycle actions ported from the rail — same commands, run
          // via executeCommand. Allow-listed so the webview can't invoke
          // arbitrary commands. Reload after so phase changes reflect.
          if (
            typeof msg.command === 'string' &&
            NANITE_TREE_COMMANDS.has(msg.command)
          ) {
            await vscode.commands.executeCommand(
              msg.command,
              ...(Array.isArray(msg.args) ? msg.args : []),
            );
            await load();
          }
          return;
        case 'togglePinTopic':
          if (typeof msg.slug === 'string' && msg.slug.length > 0) {
            await this.togglePinTopic(entry, msg.slug);
          }
          return;
        case 'setAlertStatus':
          if (
            typeof msg.id === 'string' &&
            msg.id.length > 0 &&
            (msg.status === 'alert' ||
              msg.status === 'informational' ||
              msg.status === 'closed')
          ) {
            await this.setAlertStatus(entry, msg.id, msg.status);
          }
          return;
      }
    });
  }

  /** Push a fresh view-model to an editor and mark it loaded (clears errors). */
  private pushDocument(entry: OpenEditorEntry, vm: DocumentVM): void {
    entry.errored = false;
    entry.loadedSignal = hashVm(vm);
    entry.post({ type: 'document', data: vm });
  }

  /**
   * Re-fetch every open editor's document and reconcile it with what's shown.
   * Rides the extension's existing `refresh()` signal (store-file watcher + poll
   * + control-plane-ready), so it heals stuck "connecting" editors after the
   * daemon comes up (Bug B) and live-updates open editors on external writes
   * (Bug A) — without stomping unsaved local edits. Only VISIBLE editors are
   * reconciled here; hidden ones revalidate when they become visible again (see
   * `onDidChangeViewState` in `resolveCustomEditor`).
   */
  public async refreshOpen(): Promise<void> {
    for (const entry of this.openEditors) {
      if (!entry.visible) {
        continue;
      }
      await this.refreshEntry(entry);
    }
  }

  /**
   * Re-fetch a single editor's document and reconcile it with what's displayed.
   * Change-detection compares a hash of the whole fetched VM against the hash of
   * the displayed one, so a child-only change (e.g. a closed child topic, which
   * doesn't move the workstream's own version) still triggers a re-push.
   */
  private async refreshEntry(entry: OpenEditorEntry): Promise<void> {
    const outcome = await this.loadDocument(entry.ref);
    if (outcome.status === 'notReady') {
      // Still not connected — leave the current state; a later signal retries.
      return;
    }
    if (outcome.status === 'notFound') {
      // A genuine miss is terminal (e.g. the document was deleted).
      entry.errored = true;
      entry.loadedSignal = null;
      entry.post({
        type: 'error',
        message: `Document "${entry.ref.identifier}" was not found.`,
      });
      return;
    }
    const action = decideRefreshAction({
      errored: entry.errored,
      displayedSignal: entry.loadedSignal,
      fetchedSignal: hashVm(outcome.vm),
      hasPendingEdits: entry.hasPendingEdits,
    });
    if (action === 'apply' || action === 'retry') {
      this.pushDocument(entry, outcome.vm);
    } else if (action === 'reload-banner') {
      // Newer server version + unsaved local edits: offer a reload instead of
      // overwriting. Displayed version is left unchanged until the user acts.
      entry.post({ type: 'staleReload' });
    }
    // noop: nothing to do.
  }

  /**
   * Load ANY document through the control-plane client and build a kind-keyed
   * view-model. Workstream / topic get bespoke VMs (loaded via the typed
   * `ws-*` methods); every other kind falls back to a generic envelope VM
   * (loaded via `wm-document-read`). NO database access.
   */
  private async loadDocument(ref: ParsedRef): Promise<LoadOutcome> {
    const client = this.getClient();
    if (!client) {
      // No client yet == the daemon isn't connected. NON-terminal (Bug B).
      return { status: 'notReady' };
    }
    const cpKind = controlPlaneKindFor(ref.kindHint);
    if (cpKind === 'Workstream' || cpKind === 'Topic') {
      // The typed `ws-*` reads THROW only on a dead/dropped daemon; a genuine
      // miss returns an empty result (no throw). So a thrown error here means
      // "not ready", while a null VM means "not found".
      try {
        const vm =
          cpKind === 'Workstream'
            ? await this.loadWorkstream(client, ref.identifier)
            : await this.loadTopic(client, ref.identifier);
        return vm ? { status: 'ok', vm } : { status: 'notFound' };
      } catch (err) {
        return { status: 'notReady', message: messageOf(err) };
      }
    }
    return this.loadGeneric(client, ref.identifier, cpKind);
  }

  // ---- Workstream (kind = workstream) ---------------------------------------

  private async loadWorkstream(
    client: ControlPlaneClient,
    identifier: string,
  ): Promise<WorkstreamVM | null> {
    const ws = await this.readWorkstream(client, identifier);
    if (!ws) {
      return null;
    }
    const slug = ws.slug;
    let topics: Topic[] = [];
    if (slug) {
      try {
        topics = await client.topicRead({ workstream: slug });
      } catch {
        topics = [];
      }
    }
    const rows: WorkstreamTopicVM[] = topics
      .map((t) => ({
        title: t.title,
        slug: t.slug ?? t.id,
        status: t.status,
        pinned: slug ? t.focusedWorkstreams.includes(slug) : false,
      }))
      .sort((a, b) => a.title.localeCompare(b.title));
    const ordered = [
      ...rows.filter((r) => r.pinned),
      ...rows.filter((r) => !r.pinned),
    ];
    // Full nested topic + nanite tree — the SAME composition the left rail's
    // workstream card renders. All inputs come through the control-plane client.
    let nanites: Nanite[] = [];
    let naniteTemplates: NaniteTemplate[] = [];
    let topicTypes: TopicType[] = [];
    if (slug) {
      try {
        nanites = await client.naniteRead({ workstream: slug });
      } catch {
        nanites = [];
      }
      try {
        naniteTemplates = await client.naniteTemplateRead();
      } catch {
        naniteTemplates = [];
      }
      try {
        topicTypes = await client.topicTypeRead();
      } catch {
        topicTypes = [];
      }
    }
    const typeMap = new Map<string, TopicType>(
      topicTypes.map((t) => [t.slug ?? t.id, t]),
    );
    const { groups } = buildWorkstreamTree(
      ws.id,
      slug ?? '',
      'active',
      slug ? topics : undefined,
      typeMap,
      [],
      nanites,
      naniteTemplates,
    );
    // Alerts relevant to this workstream = alerts referencing any member topic.
    const memberSlugs = topics
      .map((t) => t.slug)
      .filter((s): s is string => Boolean(s));
    let alerts: Alert[] = [];
    try {
      alerts = await client.alertRead();
    } catch {
      alerts = [];
    }
    return {
      kind: 'workstream',
      title: ws.title,
      slug,
      status: ws.status,
      createdAt: ws.opened_at,
      updatedAt: ws.updated_at,
      closure: ws.closure,
      resourceVersion: ws.resourceVersion,
      editable: Boolean(slug),
      topics: ordered,
      tree: groups.map(toTreeGroup),
      alerts: buildAlertVMs(alerts, memberSlugs, Date.now()),
    };
  }

  private async readWorkstream(
    client: ControlPlaneClient,
    identifier: string,
  ): Promise<Workstream | null> {
    // A miss returns an EMPTY array (no throw), so we fall through to the id
    // lookup; a dead/dropped daemon THROWS, which propagates to `loadDocument`
    // where it is classified as "not ready" (vs. this null → "not found").
    const bySlug = await client.wsRead({ slug: identifier });
    if (bySlug[0]) {
      return bySlug[0];
    }
    const byId = await client.wsRead({ id: identifier });
    return byId[0] ?? null;
  }

  // ---- Topic (kind = topic) -------------------------------------------------

  private async loadTopic(
    client: ControlPlaneClient,
    identifier: string,
  ): Promise<TopicVM | null> {
    const topic = await this.readTopic(client, identifier);
    if (!topic) {
      return null;
    }
    const typeMeta = await this.readTopicTypeMeta(client, topic.topicType);
    // Fetch all topics ONCE: drives both the relation title map and the child
    // lineage (topics whose `parents` include this one — the DAG below it).
    let allTopics: Topic[] = [];
    try {
      allTopics = await client.topicRead();
    } catch {
      allTopics = [];
    }
    const topicTitles = new Map<string, string>();
    for (const t of allTopics) {
      if (t.slug) {
        topicTitles.set(t.slug, t.title);
      }
    }
    const wsTitles = await this.titleMap(
      () => client.wsRead(),
      (w) => w.slug,
      (w) => w.title,
    );
    // Alerts whose `topics` reference THIS topic's slug (drives the callouts AND
    // the per-relation alert badges on the family tree).
    let alertsRaw: Alert[] = [];
    try {
      alertsRaw = await client.alertRead();
    } catch {
      alertsRaw = [];
    }
    // Non-topic relation (a workstream) — never carries a topic alert badge.
    const rel = (slug: string, titles: Map<string, string>): RelationVM => ({
      slug,
      title: titles.get(slug) ?? slug,
      alertCount: 0,
      alertSeverity: null,
    });
    // Topic relation (parent / child) — tagged with its open-alert bubble.
    const topicRel = (slug: string, title: string): RelationVM => {
      const b = alertBubbleForTopic(alertsRaw, slug);
      return { slug, title, alertCount: b.count, alertSeverity: b.severity };
    };
    const children: RelationVM[] = topic.slug
      ? allTopics
          .filter((t) => t.slug && t.parents.includes(topic.slug as string))
          .map((t) => topicRel(t.slug as string, t.title))
          .sort((a, b) => a.title.localeCompare(b.title))
      : [];
    const alerts = buildAlertVMs(
      alertsRaw,
      topic.slug ? [topic.slug] : [],
      Date.now(),
    );
    return {
      kind: 'topic',
      title: topic.title,
      slug: topic.slug,
      status: topic.status,
      topicType: topic.topicType,
      typeMeta,
      body: topic.body,
      createdAt: topic.created_at,
      updatedAt: topic.updated_at,
      resourceVersion: topic.resourceVersion,
      editable: Boolean(topic.slug),
      parents: topic.parents.map((s) => topicRel(s, topicTitles.get(s) ?? s)),
      children,
      workstreams: topic.workstreams.map((s) => rel(s, wsTitles)),
      focusedWorkstreams: topic.focusedWorkstreams.map((s) => rel(s, wsTitles)),
      alerts,
    };
  }

  private async readTopic(
    client: ControlPlaneClient,
    identifier: string,
  ): Promise<Topic | null> {
    // A miss returns an EMPTY array (no throw); a dead daemon THROWS and
    // propagates so `loadDocument` classifies it as "not ready" (not 404).
    const bySlug = await client.topicRead({ slug: identifier });
    if (bySlug[0]) {
      return bySlug[0];
    }
    const byId = await client.topicRead({ id: identifier });
    return byId[0] ?? null;
  }

  /**
   * Resolve topic-type metadata (label + icon) from the control-plane TopicType
   * kind. Returns null when the type can't be resolved so the webview falls back
   * to the raw type slug + the shared fallback icon.
   */
  private async readTopicTypeMeta(
    client: ControlPlaneClient,
    topicType: string,
  ): Promise<TopicTypeMetaVM | null> {
    if (!topicType) {
      return null;
    }
    try {
      const [bySlug] = await client.topicTypeRead({ slug: topicType });
      const tt: TopicType | undefined =
        bySlug ?? (await client.topicTypeRead({ id: topicType }))[0];
      if (!tt) {
        return null;
      }
      return {
        slug: tt.slug,
        label: tt.label,
        icon: tt.icon,
        description: tt.description,
      };
    } catch {
      return null;
    }
  }

  private async titleMap<T>(
    read: () => Promise<T[]>,
    slugOf: (t: T) => string | null,
    titleOf: (t: T) => string,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    try {
      for (const item of await read()) {
        const slug = slugOf(item);
        if (slug) {
          map.set(slug, titleOf(item));
        }
      }
    } catch {
      // best-effort — an empty map degrades relations to slug-only labels
    }
    return map;
  }

  // ---- Generic fallback (any other kind) ------------------------------------

  private async loadGeneric(
    client: ControlPlaneClient,
    identifier: string,
    cpKind: string | null,
  ): Promise<LoadOutcome> {
    // Try by id first (the `/document/<id>` form), then by slug (+ kind).
    // `available:false` == daemon down (NON-terminal); `available:true` +
    // no document == genuine 404 (terminal).
    let result = await client.getDocument(
      cpKind ? { id: identifier, kind: cpKind } : { id: identifier },
    );
    if (!result.available) {
      return { status: 'notReady', message: result.error };
    }
    if (!result.document) {
      result = await client.getDocument(
        cpKind ? { slug: identifier, kind: cpKind } : { slug: identifier },
      );
      if (!result.available) {
        return { status: 'notReady', message: result.error };
      }
    }
    if (!result.document) {
      return { status: 'notFound' };
    }
    const vm = this.buildGeneric(result.document);
    // A nanite carries its run history as separate NaniteJournal docs — fetch
    // them (newest-first) and attach so the page can render the journal list at
    // the bottom. Read-only; a fetch failure just leaves the list absent.
    if (result.document.kind === 'Nanite') {
      try {
        const journals = await client.naniteJournalRead({
          naniteId: result.document.metadata.id,
        });
        vm.journals = projectNaniteJournals(journals);
      } catch {
        // Leave `journals` absent so the webview simply omits the section.
      }
    }
    // A NaniteJournal is ONE immutable run record — surface its dedicated detail
    // (status/prompt/trace/results) plus link-outs to the owning nanite + its
    // template (both by-id). Best-effort: a fetch failure leaves the detail
    // absent so the view falls back to the generic spec dump.
    if (result.document.kind === 'NaniteJournal') {
      try {
        const [journal] = await client.naniteJournalRead({
          id: result.document.metadata.id,
        });
        if (journal) {
          const nanite = (await client.naniteRead({ id: journal.naniteId }))[0] ?? null;
          let template: NaniteTemplate | null = null;
          if (nanite?.templateId) {
            template =
              (await client.naniteTemplateRead({ slug: nanite.templateId }))[0] ??
              (await client.naniteTemplateRead({ id: nanite.templateId }))[0] ??
              null;
          }
          vm.naniteJournal = projectNaniteJournalDetail(journal, nanite, template);
        }
      } catch {
        // Leave `naniteJournal` absent so the webview omits the bespoke layout.
      }
    }
    return { status: 'ok', vm };
  }

  private buildGeneric(doc: DocumentEnvelope): GenericDocVM {
    return buildGenericVM(doc);
  }

  // ---- Autosave -------------------------------------------------------------

  private async saveWorkstream(
    entry: OpenEditorEntry,
    patch: { title?: string; status?: string },
  ): Promise<void> {
    const post = entry.post;
    const ref = entry.ref;
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — changes were not saved.',
      });
      return;
    }
    let ws: Workstream | null;
    try {
      ws = await this.readWorkstream(client, ref.identifier);
    } catch (err) {
      post({ type: 'error', message: `Save failed: ${messageOf(err)}` });
      return;
    }
    if (!ws || !ws.slug) {
      post({
        type: 'error',
        message: 'This workstream has no slug and cannot be edited yet.',
      });
      return;
    }
    const input: { slug: string; title?: string; status?: string } = {
      slug: ws.slug,
    };
    if (typeof patch.title === 'string') {
      input.title = patch.title;
    }
    if (typeof patch.status === 'string') {
      input.status = patch.status;
    }
    try {
      await client.wsUpdate(input);
    } catch (err) {
      post({
        type: 'error',
        message: `Save failed: ${messageOf(err)}`,
      });
      return;
    }
    const vm = await this.loadWorkstream(client, ref.identifier);
    if (vm) {
      this.pushDocument(entry, vm);
    }
    // Explicit host-confirmed ack — the webview flips its indicator green only
    // on THIS, never merely on posting the patch.
    post({ type: 'saved', resourceVersion: vm?.resourceVersion });
  }

  /**
   * Pin or unpin a topic in THIS workstream (ported from the rail's Add/Remove
   * to Focus). The document being edited is the workstream, so its slug is the
   * focus target; the topic's current `focusedWorkstreams` decides direction.
   * Toggles via the same control-plane methods the rail uses
   * (`topicSetFocus` / `topicClearFocus`), then reloads + re-pushes the tree.
   */
  private async togglePinTopic(
    entry: OpenEditorEntry,
    topicSlug: string,
  ): Promise<void> {
    const post = entry.post;
    const ref = entry.ref;
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — changes were not saved.',
      });
      return;
    }
    let ws: Workstream | null;
    let topic: Topic | null;
    try {
      ws = await this.readWorkstream(client, ref.identifier);
      if (ws && ws.slug) {
        topic = await this.readTopic(client, topicSlug);
      } else {
        topic = null;
      }
    } catch (err) {
      post({ type: 'error', message: `Pin failed: ${messageOf(err)}` });
      return;
    }
    if (!ws || !ws.slug) {
      post({
        type: 'error',
        message: 'This workstream has no slug, so topics cannot be pinned to it.',
      });
      return;
    }
    if (!topic || !topic.slug) {
      post({ type: 'error', message: `Topic "${topicSlug}" could not be resolved.` });
      return;
    }
    try {
      if (shouldSetFocus(topic.focusedWorkstreams, ws.slug)) {
        await client.topicSetFocus({ slug: topic.slug, workstream: ws.slug });
      } else {
        await client.topicClearFocus({ slug: topic.slug, workstream: ws.slug });
      }
    } catch (err) {
      post({
        type: 'error',
        message: `Pin failed: ${messageOf(err)}`,
      });
      return;
    }
    const vm = await this.loadWorkstream(client, ref.identifier);
    if (vm) {
      this.pushDocument(entry, vm);
    }
  }

  /**
   * Transition an alert's lifecycle status (resolve / escalate / close / reopen)
   * from a callout button. Persists via the control-plane `ws-alert-update`
   * tool (NO DB), then reloads the editor's document so the refreshed callouts
   * (and any dimming / hiding of a now-closed alert) re-render.
   */
  private async setAlertStatus(
    entry: OpenEditorEntry,
    id: string,
    status: 'alert' | 'informational' | 'closed',
  ): Promise<void> {
    const post = entry.post;
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — the alert was not updated.',
      });
      return;
    }
    try {
      await client.alertUpdate({ id, status });
    } catch (err) {
      post({ type: 'error', message: `Alert update failed: ${messageOf(err)}` });
      return;
    }
    const outcome = await this.loadDocument(entry.ref);
    if (outcome.status === 'ok') {
      this.pushDocument(entry, outcome.vm);
    }
  }

  private async saveTopic(
    entry: OpenEditorEntry,
    patch: TopicPatch,
  ): Promise<void> {
    const post = entry.post;
    const ref = entry.ref;
    const client = this.getClient();
    if (!client) {
      post({
        type: 'error',
        message: 'Control plane is not running — changes were not saved.',
      });
      return;
    }
    let topic: Topic | null;
    try {
      topic = await this.readTopic(client, ref.identifier);
    } catch (err) {
      post({ type: 'error', message: `Save failed: ${messageOf(err)}` });
      return;
    }
    if (!topic || !topic.slug) {
      post({
        type: 'error',
        message: 'This topic has no slug and cannot be edited yet.',
      });
      return;
    }
    const input: {
      slug: string;
      title?: string;
      status?: string;
      body?: string;
    } = { slug: topic.slug };
    if (typeof patch.title === 'string') {
      input.title = patch.title;
    }
    if (typeof patch.status === 'string') {
      input.status = patch.status;
    }
    if (typeof patch.body === 'string') {
      input.body = patch.body;
    }
    try {
      await client.topicUpdate(input);
    } catch (err) {
      post({
        type: 'error',
        message: `Save failed: ${messageOf(err)}`,
      });
      return;
    }
    const vm = await this.loadTopic(client, ref.identifier);
    if (vm) {
      this.pushDocument(entry, vm);
    }
    // Explicit host-confirmed ack — the webview flips its indicator green only
    // on THIS, never merely on posting the patch.
    post({ type: 'saved', resourceVersion: vm?.resourceVersion });
  }

  // ---- Inert CustomDocument hooks (autosave-through-API: never dirty) --------

  saveCustomDocument(): Thenable<void> {
    return Promise.resolve();
  }

  saveCustomDocumentAs(): Thenable<void> {
    return Promise.resolve();
  }

  revertCustomDocument(): Thenable<void> {
    return Promise.resolve();
  }

  backupCustomDocument(
    _document: WmDocument,
    context: vscode.CustomDocumentBackupContext,
  ): Thenable<vscode.CustomDocumentBackup> {
    return Promise.resolve({
      id: context.destination.toString(),
      delete: () => undefined,
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const base = vscode.Uri.joinPath(this.extensionUri, 'media', 'webview-ui');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(base, 'main.css'),
    );
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'codicons', 'codicon.css'),
    );
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="stylesheet" href="${codiconUri}" />
    <link rel="stylesheet" href="${styleUri}" />
    <title>Working Memory Document</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
  }
}
