import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  JournalStore,
  openJournalStore,
} from './db';
import { resolveDbPath } from './paths';
import { WorkstreamDocumentProvider } from './contentProvider';
import { registerTools } from './tools';
import { WorkstreamPanelProvider } from './webview/panelProvider';
import { findLatestVsix } from './vsix';
import { TRAVERSAL_MODES, type TraversalModeId } from './graphTraversals';
import { linkWorkstreamTopicWithTraversal } from './topicWorkstreamAttach';

let activeStore: JournalStore | null = null;

type TopicAddToWorkstreamCommandInput = {
  topicSlug?: string;
  traversalId?: TraversalModeId;
  workstreamSlug?: string;
};

type TopicRemoveFromWorkstreamCommandInput = {
  topicSlug?: string;
  workstreamSlug?: string;
};

function revealHeading(
  editor: vscode.TextEditor,
  section: 'sessions' | 'recent-entries' | 'entries',
): void {
  const wanted =
    section === 'sessions'
      ? 'sessions'
      : section === 'recent-entries'
        ? 'recent entries'
        : 'entries';
  for (let i = 0; i < editor.document.lineCount; i++) {
    const line = editor.document.lineAt(i).text.trim();
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (!match || !match[1]) {
      continue;
    }
    if (match[1].toLocaleLowerCase('en-US') !== wanted) {
      continue;
    }
    const pos = new vscode.Position(i, 0);
    const range = new vscode.Range(pos, pos);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    return;
  }
}

function runCommand(command: 'gh' | 'code', args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const message = stderr.trim() || stdout.trim() || `exit code ${code}`;
      reject(new Error(message));
    });
  });
}

export function activate(context: vscode.ExtensionContext): void {
  // Try to open the store first so we can pass it (or null) into every
  // provider. Failures are non-fatal — the providers degrade gracefully
  // when `store` is null.
  let store: JournalStore | null = null;
  const dbPath = resolveDbPath();
  if (!dbPath) {
    vscode.window.showWarningMessage(
      'Working Memory: no hub workspace found (need a folder with AGENTS.md and a memory/ directory). The Workstreams panel will be empty.',
    );
  } else {
    try {
      store = openJournalStore({ dbPath });
      console.log(`[working-memory] DB opened at ${store.dbPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[working-memory] openJournalStore failed:', err);
      vscode.window.showErrorMessage(
        `Working Memory: failed to open journal DB — ${message}. Title-bar actions still work; try 'Working Memory: Reload Window' after investigating.`,
      );
    }
  }
  activeStore = store;

  const panelProvider = new WorkstreamPanelProvider(
    context.extensionUri,
    store,
  );
  const contentProvider = new WorkstreamDocumentProvider(store);

  const refresh = (): void => {
    panelProvider.refresh();
    contentProvider.refresh();
  };

  const pickOpenWorkstreamSlug = async (): Promise<string | null> => {
    if (!store) {
      return null;
    }
    const rows = store.listWorkstreams({ status: 'open' });
    if (rows.length === 0) {
      vscode.window.showWarningMessage(
        'Working Memory: no open workstreams available.',
      );
      return null;
    }
    const pick = await vscode.window.showQuickPick(
      rows.map((ws) => ({
        label: ws.title,
        description: ws.slug,
        slug: ws.slug,
      })),
      { placeHolder: 'Choose a workstream' },
    );
    return pick?.slug ?? null;
  };

  const pickLinkedWorkstreamSlug = async (
    topicSlug: string,
  ): Promise<string | null> => {
    if (!store) {
      return null;
    }
    const rows = store.listWorkstreamsForTopic(topicSlug);
    if (rows.length === 0) {
      vscode.window.showWarningMessage(
        `Working Memory: topic "${topicSlug}" is not linked to any workstream.`,
      );
      return null;
    }
    const pick = await vscode.window.showQuickPick(
      rows.map((ws) => ({
        label: ws.workstream_title,
        description: ws.workstream_slug,
        slug: ws.workstream_slug,
      })),
      { placeHolder: 'Choose a workstream to remove this topic from' },
    );
    return pick?.slug ?? null;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('working-memory.refresh', refresh),
    vscode.commands.registerCommand('working-memory.reloadWindow', () => {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
    vscode.commands.registerCommand(
      'working-memory.updateToLatest',
      async () => {
        const choice = await vscode.window.showWarningMessage(
          'This will download and install the latest build of Working Memory from GitHub Actions and reload the window. Continue?',
          { modal: true },
          'Continue',
        );
        if (choice !== 'Continue') {
          return;
        }

        const downloadDir = mkdtempSync(
          join(tmpdir(), 'working-memory-update-latest-'),
        );
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Working Memory: updating to latest CI build…',
            },
            async () => {
              await runCommand('gh', [
                'run',
                'download',
                '--repo',
                'mkubarycz/working-memory',
                '--name',
                'working-memory-vsix',
                '--dir',
                downloadDir,
              ]);

              const vsixPath = findLatestVsix(downloadDir);
              if (!vsixPath) {
                throw new Error(
                  'Downloaded artifact did not contain a .vsix file.',
                );
              }

              await runCommand('code', [
                '--install-extension',
                vsixPath,
                '--force',
              ]);
            },
          );

          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to update to latest build — ${message}`,
          );
        } finally {
          rmSync(downloadDir, { recursive: true, force: true });
        }
      },
    ),
    vscode.commands.registerCommand(
      'working-memory.open',
      async (
        arg?:
          | {
              kind?: string;
              id?: string;
              revealSection?: 'sessions' | 'recent-entries' | 'entries';
            }
          | string,
        maybeId?: string,
      ) => {
        let kind: string | undefined;
        let id: string | undefined;
        let revealSection: 'sessions' | 'recent-entries' | 'entries' | undefined;
        if (typeof arg === 'string') {
          kind = arg;
          id = maybeId;
        } else if (arg && typeof arg === 'object') {
          kind = arg.kind;
          id = arg.id;
          revealSection = arg.revealSection;
        }
        if (!kind || !id) {
          const pickedKind = await vscode.window.showQuickPick(
            ['session', 'topic', 'workstream'],
            { placeHolder: 'Kind of working-memory doc to open' },
          );
          if (!pickedKind) {
            return;
          }
          kind = pickedKind;
          id = await vscode.window.showInputBox({
            prompt: `Enter ${kind} ${kind === 'session' ? 'uuid' : 'slug'}`,
          });
          if (!id) {
            return;
          }
        }
        if (kind !== 'session' && kind !== 'topic' && kind !== 'workstream') {
          vscode.window.showWarningMessage(
            `Working Memory: unknown kind "${kind}" (expected session|topic|workstream).`,
          );
          return;
        }
        const uri = vscode.Uri.parse(`working-memory:/${kind}/${id}.md`);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, {
          preview: false,
          preserveFocus: false,
        });
        if (revealSection) {
          revealHeading(editor, revealSection);
        }
      },
    ),
    vscode.commands.registerCommand(
      'working-memory.openSession',
      (id?: string) =>
        vscode.commands.executeCommand('working-memory.open', {
          kind: 'session',
          id,
        }),
    ),
    vscode.commands.registerCommand(
      'working-memory.openTopic',
      (id?: string) =>
        vscode.commands.executeCommand('working-memory.open', {
          kind: 'topic',
          id,
        }),
    ),
    vscode.commands.registerCommand(
      'working-memory.openWorkstream',
      (id?: string) =>
        vscode.commands.executeCommand('working-memory.open', {
          kind: 'workstream',
          id,
        }),
    ),
    vscode.commands.registerCommand(
      'workingMemory.topic.addToWorkstream',
      async (arg?: TopicAddToWorkstreamCommandInput) => {
        const topicSlug = arg?.topicSlug?.trim();
        if (!topicSlug) {
          vscode.window.showWarningMessage(
            'Working Memory: Add to workstream requires a topic slug.',
          );
          return;
        }
        if (!store) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot add topic to workstream — DB is not available.',
          );
          return;
        }
        const traversalId = arg?.traversalId ?? 'self';
        if (!TRAVERSAL_MODES[traversalId]) {
          const valid = Object.keys(TRAVERSAL_MODES).join(', ');
          vscode.window.showErrorMessage(
            `Working Memory: unknown traversal mode '${traversalId}' (valid: ${valid}).`,
          );
          return;
        }
        const workstreamSlug =
          arg?.workstreamSlug?.trim() || await pickOpenWorkstreamSlug();
        if (!workstreamSlug) {
          return;
        }
        try {
          const result = linkWorkstreamTopicWithTraversal(store, {
            workstream_slug: workstreamSlug,
            topic_slug: topicSlug,
            traversal: traversalId,
            includeClosed: false,
          });
          refresh();
          const changedCount = result.linked.length;
          const mode = TRAVERSAL_MODES[result.traversal];
          vscode.window.showInformationMessage(
            `Working Memory: linked ${changedCount} topic${changedCount === 1 ? '' : 's'} to "${workstreamSlug}" (${mode.label}).`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to add topic to workstream — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'workingMemory.topic.removeFromWorkstream',
      async (arg?: TopicRemoveFromWorkstreamCommandInput) => {
        const topicSlug = arg?.topicSlug?.trim();
        if (!topicSlug) {
          vscode.window.showWarningMessage(
            'Working Memory: Remove from workstream requires a topic slug.',
          );
          return;
        }
        if (!store) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot remove topic from workstream — DB is not available.',
          );
          return;
        }
        const workstreamSlug =
          arg?.workstreamSlug?.trim() || await pickLinkedWorkstreamSlug(topicSlug);
        if (!workstreamSlug) {
          return;
        }
        try {
          const result = store.unlinkWorkstreamTopic({
            workstream_slug: workstreamSlug,
            topic_slug: topicSlug,
          });
          refresh();
          if (result.removed > 0) {
            vscode.window.showInformationMessage(
              `Working Memory: removed "${topicSlug}" from "${workstreamSlug}".`,
            );
          } else {
            vscode.window.showInformationMessage(
              `Working Memory: "${topicSlug}" was not linked to "${workstreamSlug}".`,
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to remove topic from workstream — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'working-memory.reopenWorkstream',
      async (arg?: { slug?: string; workstream?: { slug?: string } }) => {
        const slug = arg?.slug ?? arg?.workstream?.slug;
        if (!slug) {
          vscode.window.showWarningMessage(
            'Working Memory: Reopen Workstream requires a workstream slug.',
          );
          return;
        }
        if (!store) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot reopen — DB is not available.',
          );
          return;
        }
        try {
          const updated = store.reopenWorkstream(slug);
          refresh();
          vscode.window.showInformationMessage(
            `Working Memory: reopened "${updated.title}".`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to reopen workstream — ${message}`,
          );
        }
      },
    ),
    vscode.window.registerWebviewViewProvider(
      WorkstreamPanelProvider.viewType,
      panelProvider,
    ),
    vscode.workspace.registerFileSystemProvider(
      WorkstreamDocumentProvider.scheme,
      contentProvider,
      { isCaseSensitive: true, isReadonly: false },
    ),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        const parts = uri.path.split('/').filter((p) => p.length > 0);
        if (parts.length !== 3 || parts[0] !== 'open') {
          vscode.window.showErrorMessage(
            `Working Memory: unrecognized deep link: ${uri.toString()}`,
          );
          return;
        }
        const kind = parts[1];
        if (kind !== 'session' && kind !== 'topic' && kind !== 'workstream') {
          vscode.window.showErrorMessage(
            `Working Memory: unrecognized deep link: ${uri.toString()}`,
          );
          return;
        }
        let id: string;
        try {
          id = decodeURIComponent(parts[2]);
        } catch {
          vscode.window.showErrorMessage(
            `Working Memory: unrecognized deep link: ${uri.toString()}`,
          );
          return;
        }
        void vscode.commands.executeCommand('working-memory.open', {
          kind,
          id,
        });
      },
    }),
  );

  // Tools only register when we have a live store. Without one, there's no
  // useful work for them to do, and the safety branch they used to carry
  // ("DB not open" error result) was removed by the JournalStore refactor.
  if (store) {
    registerTools(context, store, { refresh });
    refresh();
  }
}

export function deactivate(): void {
  try {
    if (activeStore) {
      activeStore.close();
      activeStore = null;
    }
  } catch (err) {
    console.error('[working-memory] store.close failed:', err);
  }
}
