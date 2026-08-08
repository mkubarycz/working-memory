import * as vscode from 'vscode';

/**
 * The `working-memory:` `FileSystemProvider`.
 *
 * As of WM 14.2.1 every Working Memory document opens in the unified Svelte
 * custom editor (`workingMemory.documentEditor`), which loads its own data
 * through the control-plane client. This provider therefore does ONE thing:
 * make the synthetic editor URIs *resolve* so `vscode.openWith` can bind the
 * custom editor to them. There is no on-disk file, no control-plane access, and
 * no markdown rendering here — the old `.md` virtual-doc screens were removed
 * when the editor took over every kind.
 *
 * Two URI shapes are served, both as zero-byte handles:
 *   - `working-memory:/<kind>/<slug-or-id>.working-memory` — the unified editor
 *     (kind ∈ workstream | topic | topic-type | alert | document | …).
 *   - `working-memory:/workstream/<slug>.workstream` — a legacy handle kept so
 *     any lingering deep links still resolve into the editor.
 */

type DocKind = 'document-editor' | 'workstream-editor' | 'unknown';

function classifyUri(uri: vscode.Uri): { kind: DocKind; slug: string | null } {
  const p = uri.path;
  // The unified custom editor is URI-addressed via a synthetic `.working-memory`
  // extension so the `customEditors` `filenamePattern` matches. Any
  // `/<kind>/<id>.working-memory` path routes here.
  if (p.endsWith('.working-memory')) {
    const m = /^\/[^/]+\/(.+)\.working-memory$/.exec(p);
    return { kind: 'document-editor', slug: (m && m[1]) || p };
  }
  // Legacy `.workstream` synthetic handle (kept as a fallback so any lingering
  // deep links still resolve into the unified editor).
  if (p.startsWith('/workstream/') && p.endsWith('.workstream')) {
    const slug = p.slice(
      '/workstream/'.length,
      p.length - '.workstream'.length,
    );
    return { kind: 'workstream-editor', slug: slug || null };
  }
  return { kind: 'unknown', slug: null };
}

export class WorkstreamDocumentProvider implements vscode.FileSystemProvider {
  public static readonly scheme = 'working-memory';

  private readonly _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private readonly knownUris = new Set<string>();
  private readonly mtimes = new Map<string, number>();

  /**
   * Bump the mtime of a known URI (or all of them) so VS Code re-stats the
   * synthetic handle. Kept because the extension calls `refresh()` on every
   * control-plane change; the editor itself reloads its own view-model.
   */
  refresh(uri?: vscode.Uri): void {
    if (uri) {
      this.markChanged(uri);
      return;
    }
    for (const key of this.knownUris) {
      this.markChanged(vscode.Uri.parse(key));
    }
  }

  private markChanged(uri: vscode.Uri): void {
    this.mtimes.set(uri.toString(), Date.now());
    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Changed, uri },
    ]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const { kind, slug } = classifyUri(uri);
    if (kind === 'unknown' || !slug) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.knownUris.add(uri.toString());
    const mtime = this.mtimes.get(uri.toString()) ?? Date.now();
    // Synthetic handle for the custom editor — no bytes, no control-plane
    // round-trip. Writable perms so `vscode.openWith` doesn't badge it
    // read-only; the editor never actually writes through the FS.
    return {
      type: vscode.FileType.File,
      ctime: mtime,
      mtime,
      size: 0,
      permissions: undefined,
    };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  createDirectory(): void {
    // no-op
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const { kind, slug } = classifyUri(uri);
    if (kind === 'unknown' || !slug) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.knownUris.add(uri.toString());
    // The custom editor loads its own data; the URI just needs to resolve.
    return new Uint8Array();
  }

  writeFile(uri: vscode.Uri): void {
    // The unified editor autosaves through the control-plane API, never through
    // the file system, so any write to a synthetic handle is rejected.
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
