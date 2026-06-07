import * as vscode from 'vscode';
import {
  getTopic,
  getWorkstreamBySlug,
  listEntriesForSession,
  listEntriesForTopic,
  listSessionsForWorkstream,
  listTopicsForWorkstream,
  listWorkstreamsForTopic,
  updateTopic,
  type Session,
  type TopicEntryLink,
} from './db';

const TZ = 'America/New_York';

function fmtDateTime(unixSeconds: number | null | undefined): string {
  if (!unixSeconds) {
    return '—';
  }
  const d = new Date(unixSeconds * 1000);
  const date = d.toLocaleDateString('en-CA', { timeZone: TZ });
  const time = d.toLocaleTimeString('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${date} ${time}`;
}

function fmtTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function renderSession(session: Session): string {
  const header = `### ${session.session_id} — ${fmtDateTime(session.started_at)}`;
  const summary = session.summary?.trim()
    ? session.summary.trim()
    : '_No summary._';
  const entries = listEntriesForSession(session.session_id);
  const entryLines = entries.length
    ? entries.map((e) => `- \`${fmtTime(e.timestamp)}\` ${e.body}`).join('\n')
    : '_No entries._';
  return `${header}\n${summary}\n\n${entryLines}`;
}

function renderWorkstreamDoc(slug: string): string {
  const ws = getWorkstreamBySlug(slug);
  if (!ws) {
    return `# Workstream not found\n\nNo workstream with slug \`${slug}\`.`;
  }
  const topics = listTopicsForWorkstream(ws.id);
  const topicsBlock = topics.length
    ? topics
        .map((t) => {
          const here = t.entry_count_in_workstream;
          const elsewhere = t.entry_count - here;
          const parts: string[] = [];
          if (here > 0) {
            parts.push(`${here} entr${here === 1 ? 'y' : 'ies'} here`);
          }
          if (elsewhere > 0) {
            parts.push(`${elsewhere} elsewhere`);
          }
          if (t.status !== 'active') {
            parts.push(`_${t.status}_`);
          }
          const meta = parts.length ? ` — ${parts.join(' • ')}` : '';
          return `- [${t.title}](working-memory:/topic/${t.slug}.md) \`${t.slug}\`${meta}`;
        })
        .join('\n')
    : '_No topics linked yet._';

  const sessions = listSessionsForWorkstream(ws.id);
  const sessionsBlock = sessions.length
    ? sessions.map(renderSession).join('\n\n')
    : '_No sessions logged yet._';

  return [
    `# ${ws.title}`,
    '',
    `- **Slug:** \`${ws.slug}\``,
    `- **Status:** ${ws.status}`,
    `- **Opened:** ${fmtDateTime(ws.opened_at)}`,
    `- **Closed:** ${fmtDateTime(ws.closed_at)}`,
    `- **Closure:** ${ws.closure?.trim() ? ws.closure.trim() : '—'}`,
    '',
    '---',
    '',
    '## Topics',
    '',
    topicsBlock,
    '',
    '---',
    '',
    '## Sessions',
    '',
    sessionsBlock,
    '',
  ].join('\n');
}

/**
 * Topic doc layout (the two `---` lines act as the body fences on read AND write):
 *
 *     # Title
 *     - metadata...
 *     ---
 *     <BODY — editable region>
 *     ---
 *     ## Linked workstreams
 *     ...
 *     ## Recent entries
 *     ...
 */
function renderTopicDoc(slug: string): string {
  const topic = getTopic(slug);
  if (!topic) {
    return `# Topic not found\n\nNo topic with slug \`${slug}\`.\n\n_Tip: use the \`wm_create_topic\` tool to create it._\n`;
  }
  const workstreams = listWorkstreamsForTopic(slug);
  const entries = listEntriesForTopic(slug, 25);

  const wsBlock = workstreams.length
    ? workstreams
        .map(
          (w) =>
            `- [${w.workstream_title}](working-memory:/workstream/${w.workstream_slug}.md) \`${w.workstream_slug}\` — linked ${fmtDateTime(w.linked_at)}`,
        )
        .join('\n')
    : '_No workstreams linked yet._';

  const byWs = new Map<string, { title: string; rows: TopicEntryLink[] }>();
  for (const e of entries) {
    const key = e.workstream_slug;
    if (!byWs.has(key)) {
      byWs.set(key, { title: e.workstream_title, rows: [] });
    }
    byWs.get(key)!.rows.push(e);
  }
  const entriesBlock = entries.length
    ? Array.from(byWs.entries())
        .map(([wsSlug, { title, rows }]) => {
          const lines = rows
            .map(
              (e) =>
                `- \`${fmtDateTime(e.timestamp)}\` [#${e.entry_id}](working-memory:/workstream/${wsSlug}.md) ${e.snippet}`,
            )
            .join('\n');
          return `### [${title}](working-memory:/workstream/${wsSlug}.md) \`${wsSlug}\`\n${lines}`;
        })
        .join('\n\n')
    : '_No entries linked yet._';

  return [
    `# ${topic.title}`,
    '',
    `- **Slug:** \`${topic.slug}\``,
    `- **Status:** ${topic.status}`,
    `- **Created:** ${fmtDateTime(topic.created_at)}`,
    `- **Updated:** ${fmtDateTime(topic.updated_at)}`,
    '',
    '---',
    '',
    topic.body.trim().length ? topic.body : '_Empty body — write something here, then save (⌘S)._',
    '',
    '---',
    '',
    '## Linked workstreams',
    '',
    wsBlock,
    '',
    '## Recent entries',
    '',
    entriesBlock,
    '',
  ].join('\n');
}

/**
 * Parse a topic doc on save. Returns the body text between the two `---`
 * fences that follow the metadata header.
 */
function extractTopicBody(full: string): string {
  const lines = full.split(/\r?\n/);
  const fenceIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      fenceIdxs.push(i);
      if (fenceIdxs.length === 2) {
        break;
      }
    }
  }
  if (fenceIdxs.length < 2) {
    throw new Error(
      'topic doc is missing the two `---` body fences — refusing to save',
    );
  }
  const body = lines
    .slice(fenceIdxs[0] + 1, fenceIdxs[1])
    .join('\n')
    .replace(/^\s*\n+/, '')
    .replace(/\n+\s*$/, '');
  const placeholder = '_Empty body — write something here, then save (⌘S)._';
  if (body.trim() === placeholder) {
    return '';
  }
  return body;
}

type DocKind = 'workstream' | 'topic' | 'unknown';

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
  return { kind: 'unknown', slug: null };
}

/**
 * `FileSystemProvider` for the `working-memory:` scheme. Workstream docs are
 * read-only (the body is rendered fresh from the DB every read); topic docs
 * are writable — on save we parse the body fence region and persist it via
 * `updateTopic()`.
 */
export class WorkstreamDocumentProvider implements vscode.FileSystemProvider {
  public static readonly scheme = 'working-memory';

  private readonly _onDidChangeFile = new vscode.EventEmitter<
    vscode.FileChangeEvent[]
  >();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  private readonly knownUris = new Set<string>();
  private readonly mtimes = new Map<string, number>();

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
        kind === 'topic' ? undefined : vscode.FilePermission.Readonly,
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
    const topic = getTopic(slug);
    if (!topic) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    const text = Buffer.from(content).toString('utf8');
    const body = extractTopicBody(text);
    updateTopic(slug, { body });
    this.markChanged(uri);
  }

  delete(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  private render(kind: DocKind, slug: string, uri: vscode.Uri): string {
    if (kind === 'workstream') {
      return renderWorkstreamDoc(slug);
    }
    if (kind === 'topic') {
      return renderTopicDoc(slug);
    }
    return `# Unknown working-memory URI\n\n\`${uri.toString()}\``;
  }
}
