/**
 * Backward-compat shim (WM 14.2 "svelte-document-editor").
 *
 * The per-kind workstream editor was FOLDED into the unified
 * {@link DocumentEditorProvider} (viewType `workingMemory.documentEditor`),
 * which dispatches its UI by document kind. This module re-exports the unified
 * provider under the historical name plus a `uriFor(slug)` that builds a
 * `workstream`-kind `.working-memory` URI, so any lingering references keep
 * working without change.
 */
import * as vscode from 'vscode';
import { DocumentEditorProvider } from './documentEditorProvider';

export class WorkstreamEditorProvider extends DocumentEditorProvider {
  /** The unified editor's viewType — the workstream editor no longer has its own. */
  public static readonly viewType = DocumentEditorProvider.viewType;

  /** Build the virtual URI that opens a workstream in the unified editor. */
  public static uriFor(slugOrId: string): vscode.Uri {
    return DocumentEditorProvider.uriFor('workstream', slugOrId);
  }
}
