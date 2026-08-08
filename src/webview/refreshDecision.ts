/**
 * Pure decision logic for the document editor's external-change refresh
 * (WM "document-editor-live-refresh").
 *
 * When the store changes out-of-process, the extension re-fetches the visible
 * editors' documents and must decide what to do with each fresh view-model.
 * This module isolates that choice — displayed signal vs fetched signal,
 * whether the editor is currently errored/unloaded, and whether the user has
 * unsaved local edits — so it can be unit-tested without VS Code or the
 * webview. The signal is opaque: the host produces it by hashing the whole
 * fetched view-model (`hashVm`), so equality alone decides "changed vs
 * unchanged" — there is no version arithmetic here.
 */

/** What `refreshOpen` should do with a freshly-fetched document. */
export type RefreshAction = 'apply' | 'reload-banner' | 'retry' | 'noop';

/**
 * An opaque change-detection signal: the host's `hashVm` string of an entire
 * view-model. Two signals are only ever compared for equality, so any change
 * anywhere in the VM (including embedded child rows) reads as "changed".
 */
export type RefreshSignal = string;

export interface RefreshDecisionInput {
  /**
   * True when the editor is currently showing an error / connecting state or
   * has not yet loaded a document (so the fetch should HEAL it).
   */
  errored: boolean;
  /** The signal currently displayed, or null when nothing is loaded. */
  displayedSignal: RefreshSignal | null;
  /** The signal just derived from the freshly-fetched document. */
  fetchedSignal: RefreshSignal;
  /** True when the user has un-flushed local edits in the editor. */
  hasPendingEdits: boolean;
}

/**
 * Decide how to reconcile a freshly-fetched document with what the editor shows:
 *  - `retry`         — editor is errored/unloaded → apply the fetch to heal it.
 *  - `noop`          — fetched version matches what's displayed → nothing to do.
 *  - `reload-banner` — a NEWER version exists but the user has unsaved edits →
 *                      surface a "content changed — reload" affordance instead
 *                      of stomping their in-progress work.
 *  - `apply`         — the version differs and there are no local edits → push
 *                      the fresh view-model straight in.
 */
export function decideRefreshAction(input: RefreshDecisionInput): RefreshAction {
  if (input.errored || input.displayedSignal === null) {
    return 'retry';
  }
  if (input.fetchedSignal === input.displayedSignal) {
    return 'noop';
  }
  return input.hasPendingEdits ? 'reload-banner' : 'apply';
}
