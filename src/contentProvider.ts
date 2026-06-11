import * as vscode from 'vscode';
import { JournalStore } from './db';
import {
  renderWorkstreamDoc,
  renderTopicDoc,
  renderTopicTypeDoc,
  renderSessionDoc,
  extractTopicBody,
} from './renderer';

type DocKind = 'workstream' | 'topic' | 'topic-type' | 'session' | 'unknown';

function classifyUri(uri: vscode.Uri): { kind: DocKind; slug: string | null } {
  const p = uri.path;
  if (p.startsWith('/workstream/') && p.endsWith('.md')) {
    const slug = p.slice('/workstream/'.length, p.length - '.md'.length);
    return { kind: 'workstream', slug: slug || null };
  }
  if (p.startsWith('/topic/') && p.endsWith('.md')) {
    const slug = p.slice('/topic/'.length, p.length - '.md'.length);
    return { kind: 'topic', slug: slug || null };
  }
  if (p.startsWith('/topic-type/') && p.endsWith('.md')) {
    const id = p.slice('/topic-type/'.length, p.length - '.md'.length);
    return { kind: 'topic-type', slug: id || null };
  }
  if (p.startsWith('/session/') && p.endsWith('.md')) {
    const id = p.slice('/session/'.length, p.length - '.md'.length);
    return { kind: 'session', slug: id || null };
  }
  return { kind: 'unknown', slug: null };
}

/**
 * `FileSystemProvider` for the `working-memory:` scheme. Workstream and
 * session docs are read-only (rendered fresh from the DB every read);
 * topic docs are writable — on save we parse the body fence region and
 * persist it via `store.updateTopic()`. When `store` is null (no hub
 * workspace) every doc renders a "DB not available" body and writes
 * are rejected.
 */
export class WorkstreamDocumentProvider implements vscode.FileSystemProvider {
  public static readonly scheme = 'working-memory';

  private readonly _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private readonly knownUris = new Set<string>();
  private readonly mtimes = new Map<string, number>();

  constructor(private readonly store: JournalStore | null) {}

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
    if (!slug) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.knownUris.add(uri.toString());
    const text = this.render(kind, slug, uri);
    const mtime = this.mtimes.get(uri.toString()) ?? Date.now();
    return {
      type: vscode.FileType.File,
      ctime: mtime,
      mtime,
      size: Buffer.byteLength(text, 'utf8'),
      permissions:
        kind === 'topic' && this.store
          ? undefined
          : vscode.FilePermission.Readonly,
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
    if (!slug) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    this.knownUris.add(uri.toString());
    const text = this.render(kind, slug, uri);
    return Buffer.from(text, 'utf8');
  }

  writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    _options: { create: boolean; overwrite: boolean },
  ): void {
    const { kind, slug } = classifyUri(uri);
    if (kind !== 'topic' || !slug) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    if (!this.store) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
    const topic = this.store.getTopic(slug);
    if (!topic) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const text = Buffer.from(content).toString('utf8');
    const body = extractTopicBody(text);
    this.store.updateTopic(slug, { body });
    this.markChanged(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  private render(kind: DocKind, slug: string, uri: vscode.Uri): string {
    if (!this.store) {
      return [
        `# Working Memory DB not available`,
        '',
        `Cannot render \`${uri.toString()}\` — no hub workspace is open.`,
        '',
        '_Tip: open the folder containing `AGENTS.md` and a `memory/`_',
        '_directory, then run "Working Memory: Reload Window"._',
        '',
      ].join('\n');
    }
    if (kind === 'workstream') {
      return renderWorkstreamDoc(this.store, slug);
    }
    if (kind === 'topic') {
      return renderTopicDoc(this.store, slug);
    }
    if (kind === 'topic-type') {
      return renderTopicTypeDoc(this.store, slug);
    }
    if (kind === 'session') {
      return renderSessionDoc(this.store, slug);
    }
    return `# Unknown working-memory URI\n\n\`${uri.toString()}\``;
  }
}
