/**
 * Tiny URI parser shared by the extension host (tab-group watcher) and the
 * reveal-in-panel feature. Pure string in / plain-object out so it can be
 * unit-tested without importing `vscode`. Only the kinds the panel can reveal
 * are recognized.
 *
 * WM docs now open in the unified custom editor
 * (`workingMemory.documentEditor`) under
 * `working-memory:/<kind>/<id>.working-memory` URIs. Those custom-editor tabs
 * carry a real source URI, so the old `.md` / Markdown-Preview /
 * label-disambiguation machinery is gone — a tab's URI is all we need to
 * resolve a reveal target.
 */
export type RevealKind = 'session' | 'topic' | 'workstream' | 'topic-type';

export interface PanelRevealTarget {
  kind: RevealKind;
  id: string;
}

/** The custom URI scheme our virtual docs live under. */
export const WM_SCHEME = 'working-memory';

/** viewType of the unified custom document editor that renders WM docs. */
export const WM_DOCUMENT_EDITOR_VIEW_TYPE = 'workingMemory.documentEditor';

const REVEAL_URI_RE =
  /^working-memory:\/(session|topic|workstream|topic-type)\/(.+)\.working-memory$/;

/**
 * Parse a `working-memory:/<kind>/<id>.working-memory` URI string into a reveal
 * target. Returns null for anything that isn't a revealable WM doc. Pass
 * `uri.scheme + ':' + uri.path` from a `vscode.Uri`.
 */
export function parsePanelRevealTarget(uri: string): PanelRevealTarget | null {
  const match = REVEAL_URI_RE.exec(uri);
  if (!match) {
    return null;
  }
  const kind = match[1] as RevealKind;
  let id = match[2];
  try {
    id = decodeURIComponent(id);
  } catch {
    // Keep the raw segment if it isn't valid percent-encoding.
  }
  if (!id) {
    return null;
  }
  return { kind, id };
}

/**
 * Minimal, vscode-free description of one open editor tab, so this module stays
 * pure and unit-testable. A `custom` tab is a `vscode.TabInputCustom` (custom
 * editor) and exposes both a source `uri` and its `viewType`.
 */
export interface TabDescriptor {
  kind: 'custom' | 'other';
  /** URI scheme for `custom` tabs (e.g. `working-memory`). */
  scheme?: string;
  /** `uri.path` for `custom` tabs (already percent-decoded by vscode). */
  path?: string;
  /** Custom-editor `viewType` for `custom` tabs. */
  viewType?: string;
}

/**
 * Resolve the active tab to a reveal target. Only a focused WM
 * document-editor tab (`workingMemory.documentEditor` viewType on a
 * `working-memory:` URI) reveals — anything else clears the highlight.
 */
export function resolveRevealFromTabs(
  active: TabDescriptor | null,
): PanelRevealTarget | null {
  if (!active) {
    return null;
  }
  if (
    active.kind === 'custom' &&
    active.viewType === WM_DOCUMENT_EDITOR_VIEW_TYPE &&
    active.scheme === WM_SCHEME &&
    active.path
  ) {
    return parsePanelRevealTarget(`${WM_SCHEME}:${active.path}`);
  }
  return null;
}
