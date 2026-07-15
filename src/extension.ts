import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  JournalStore,
  openJournalStore,
} from './db';
import { findHubWorkspace, resolveDbPath } from './paths';
import { WorkstreamDocumentProvider } from './contentProvider';
import { AlertsStore, ALERTS_ENABLED, type AlertStatus } from './alerts';
import { NanitesStore, NANITES_ENABLED } from './nanites';
import { registerTools } from './tools';
import { WorkstreamPanelProvider } from './webview/panelProvider';
import {
  isMarkdownPreviewViewType,
  resolveRevealFromTabs,
  type TabDescriptor,
  type PanelRevealTarget,
} from './panelReveal';
import { findLatestVsix } from './vsix';
import { deployTemplates } from './deployTemplates';
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

function backupTimestamp(date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  const ymd = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const hms = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${ymd}-${hms}`;
}

/**
 * Snapshot the live journal DB (and its `-wal`/`-shm` sidecars) into
 * `<hub>/memory/.backups/`. Shared by the pre-upgrade path and the on-demand
 * "Back up journal database now" button.
 *
 * `label` is the marker embedded between the `journal-` prefix and the
 * timestamp, distinguishing snapshot kinds:
 *   - pre-upgrade: `pre-v<version>`  → journal-pre-v0.11.4-<YYYYMMDD>-<HHMMSS>.sqlite
 *   - manual:      `manual`          → journal-manual-<YYYYMMDD>-<HHMMSS>.sqlite
 *
 * Throws on any failure so callers can abort the operation. Returns the path of
 * the main `.sqlite` snapshot, or `null` when there is no live DB to back up
 * (e.g. first run) — that is not an error.
 */
function backupJournalDb(label: string): string | null {
  const dbPath = resolveDbPath();
  if (!dbPath) {
    throw new Error(
      'could not locate the hub workspace journal database (no memory/ folder among open workspace folders).',
    );
  }
  if (!existsSync(dbPath)) {
    // No live DB yet — nothing at risk, nothing to snapshot.
    return null;
  }

  const backupDir = join(dirname(dbPath), '.backups');
  mkdirSync(backupDir, { recursive: true });

  const snapBase = join(backupDir, `journal-${label}-${backupTimestamp()}`);
  const mainSnapshot = `${snapBase}.sqlite`;
  copyFileSync(dbPath, mainSnapshot);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      copyFileSync(sidecar, `${snapBase}.sqlite${suffix}`);
    }
  }
  return mainSnapshot;
}

function runCommand(command: 'gh' | 'code', args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // On Windows, `gh`/`code` ship as `.cmd` shims. Node's CVE-2024-27980
    // fix makes spawn() throw EINVAL when launching a .cmd/.bat with
    // shell:false, so we must run through a shell. With shell:true we pass
    // the bare command name (PATH resolves the shim) and quote each arg
    // ourselves so paths with spaces survive and embedded quotes can't
    // break out (injection guard). On non-win32 we keep shell:false with
    // the bare command and pass args verbatim.
    const isWin = process.platform === 'win32';
    const spawnArgs = isWin
      ? args.map((a) => `"${a.replace(/"/g, '\\"')}"`)
      : args;
    const child = spawn(command, spawnArgs, { shell: isWin });
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
  // Register the FileSystemProvider for the working-memory: scheme
  // synchronously and first — before any DB access — so that restored
  // Markdown Preview webview editors can resolve working-memory: URIs
  // during the startup restore race.  The onFileSystem:working-memory
  // activation event fires before onStartupFinished when a
  // working-memory: URI is already open, giving the preview webview a
  // live provider to call into.  The provider degrades gracefully while
  // store is null (returns placeholder content) and is updated with the
  // real store once the DB opens below.
  const contentProvider = new WorkstreamDocumentProvider(null);
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      WorkstreamDocumentProvider.scheme,
      contentProvider,
      { isCaseSensitive: true, isReadonly: false },
    ),
  );

  // Try to open the store so we can wire it into every provider.
  // Failures are non-fatal — the providers degrade gracefully when
  // `store` is null.
  let store: JournalStore | null = null;
  const hub = findHubWorkspace();
  if (hub) {
    try {
      const currentVersion = context.extension.packageJSON.version as string;
      const deployedVersion = context.globalState.get<string>(
        'working-memory.deployedVersion',
      );
      // Skip redeploy when templates already match the installed version.
      if (deployedVersion !== currentVersion) {
        deployTemplates(context, hub);
        void context.globalState.update(
          'working-memory.deployedVersion',
          currentVersion,
        );
      }
    } catch (err) {
      console.error('[working-memory] deployTemplates failed:', err);
    }
  }
  const dbPath = resolveDbPath();
  if (!dbPath) {
    vscode.window.showWarningMessage(
      'Working Memory: no hub workspace found (need a folder containing a memory/ directory). The Workstreams panel will be empty.',
    );
  } else {
    try {
      store = openJournalStore({ dbPath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[working-memory] openJournalStore failed:', err);
      vscode.window.showErrorMessage(
        `Working Memory: failed to open journal DB — ${message}. Title-bar actions still work; try 'Working Memory: Reload Window' after investigating.`,
      );
    }
  }
  activeStore = store;

  // Wire the real store into the already-registered FSP and create the
  // remaining providers.
  contentProvider.updateStore(store);

  const panelProvider = new WorkstreamPanelProvider(
    context.extensionUri,
    store,
  );

  const refresh = (): void => {
    panelProvider.refresh();
    contentProvider.refresh();
  };

  const setAlertStatus = (
    arg: number | { id?: number } | undefined,
    status: AlertStatus,
  ): void => {
    const id = typeof arg === 'number' ? arg : arg?.id;
    if (!id) {
      return;
    }
    if (!store || !ALERTS_ENABLED) {
      vscode.window.showErrorMessage('Working Memory: alerts unavailable.');
      return;
    }
    try {
      new AlertsStore(store.connection).updateAlert(id, { status });
      refresh();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Working Memory: ${m}`);
    }
  };

  const editAlertField = async (
    id: number | undefined,
    field: 'description' | 'recommended_action',
  ): Promise<void> => {
    if (!id || !store || !ALERTS_ENABLED) {
      vscode.window.showErrorMessage('Working Memory: alerts unavailable.');
      return;
    }
    const alerts = new AlertsStore(store.connection);
    const current = alerts.getAlert(id);
    if (!current) {
      vscode.window.showWarningMessage(`Working Memory: alert #${id} not found.`);
      return;
    }
    const value = await vscode.window.showInputBox({
      prompt: field === 'description' ? 'Alert description' : 'Recommended action',
      value: current[field],
    });
    if (value === undefined) {
      return;
    }
    try {
      alerts.updateAlert(id, { [field]: value });
      refresh();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Working Memory: ${m}`);
    }
  };

  // Derive the visible WM doc from tabGroups, not window.activeTextEditor:
  // the latter goes undefined when the WM webview takes focus, and Markdown
  // Preview tabs expose no source URI. lastWmRevealTarget is the fallback for
  // when the source text tab has since been closed.
  let lastWmRevealTarget: PanelRevealTarget | null = null;

  const classifyTab = (tab: vscode.Tab | undefined): TabDescriptor => {
    const input = tab?.input;
    if (input instanceof vscode.TabInputText) {
      // uri.path is already percent-decoded.
      return {
        kind: 'text',
        scheme: input.uri.scheme,
        path: input.uri.path,
        label: tab?.label,
      };
    }
    if (
      input instanceof vscode.TabInputWebview &&
      isMarkdownPreviewViewType(input.viewType)
    ) {
      return { kind: 'preview', label: tab?.label };
    }
    return { kind: 'other', label: tab?.label };
  };

  const pushActiveRevealTarget = (): void => {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const activeDesc = classifyTab(activeTab);

    const allDescs: TabDescriptor[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        allDescs.push(classifyTab(tab));
      }
    }

    let target = resolveRevealFromTabs(allDescs, activeDesc);
    if (!target && activeDesc.kind === 'preview' && lastWmRevealTarget) {
      // Source text tab was closed but its preview is still active — replay.
      target = lastWmRevealTarget;
    }
    if (target) {
      lastWmRevealTarget = target;
    }

    panelProvider.reveal(target);
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
          'This will download and install the latest tagged release of Working Memory from GitHub and reload the window. Continue?',
          { modal: true },
          'Continue',
        );
        if (choice !== 'Continue') {
          return;
        }

        const downloadDir = mkdtempSync(
          join(tmpdir(), 'working-memory-update-latest-'),
        );
        let backupPath: string | null = null;
        try {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: 'Working Memory: updating to latest tagged release…',
            },
            async () => {
              await runCommand('gh', [
                'release',
                'download',
                '--repo',
                'mkubarycz/working-memory',
                '--pattern',
                '*.vsix',
                '--dir',
                downloadDir,
              ]);

              const vsixPath = findLatestVsix(downloadDir);
              if (!vsixPath) {
                throw new Error(
                  'Downloaded release did not contain a .vsix file.',
                );
              }

              // Always snapshot the live journal DB BEFORE installing. A failed
              // backup must abort the upgrade so we never install over an
              // un-snapshotted DB.
              try {
                backupPath = backupJournalDb(
                  `pre-v${context.extension.packageJSON.version as string}`,
                );
              } catch (backupErr) {
                const detail =
                  backupErr instanceof Error
                    ? backupErr.message
                    : String(backupErr);
                throw new Error(`pre-upgrade DB backup failed — ${detail}`);
              }

              await runCommand('code', [
                '--install-extension',
                vsixPath,
                '--force',
              ]);
            },
          );

          const backupNote = backupPath
            ? ` DB backed up to ${backupPath}.`
            : '';
          const reloadChoice = await vscode.window.showInformationMessage(
            `Working Memory updated to the latest release.${backupNote} Reload the window to activate it.`,
            'Reload Window',
          );
          if (reloadChoice === 'Reload Window') {
            await vscode.commands.executeCommand(
              'workbench.action.reloadWindow',
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to update to latest release — ${message}`,
          );
        } finally {
          rmSync(downloadDir, { recursive: true, force: true });
        }
      },
    ),
    vscode.commands.registerCommand('working-memory.backupNow', () => {
      let snapshotPath: string | null;
      try {
        snapshotPath = backupJournalDb('manual');
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(
          `Working Memory: backup failed — ${message}`,
        );
        return;
      }
      if (!snapshotPath) {
        vscode.window.showInformationMessage(
          'Working Memory: nothing to back up — no live journal database found yet.',
        );
        return;
      }
      vscode.window.showInformationMessage(
        `Working Memory: journal database backed up to ${snapshotPath}.`,
      );
    }),
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
            ['session', 'topic', 'topic-type', 'workstream', 'alert', 'nanite'],
            { placeHolder: 'Kind of working-memory doc to open' },
          );
          if (!pickedKind) {
            return;
          }
          kind = pickedKind;
          id = await vscode.window.showInputBox({
            prompt: `Enter ${kind} ${kind === 'session' ? 'uuid' : 'slug/id'}`,
          });
          if (!id) {
            return;
          }
        }
        if (
          kind !== 'session' &&
          kind !== 'topic' &&
          kind !== 'topic-type' &&
          kind !== 'workstream' &&
          kind !== 'alert' &&
          kind !== 'nanite' &&
          kind !== 'nanite-run'
        ) {
          vscode.window.showWarningMessage(
            `Working Memory: unknown kind "${kind}" (expected session|topic|topic-type|workstream|alert|nanite|nanite-run).`,
          );
          return;
        }
        const uri = vscode.Uri.parse(`working-memory:/${kind}/${id}.md`);
        if (revealSection) {
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc, {
            preview: false,
            preserveFocus: false,
          });
          revealHeading(editor, revealSection);
          return;
        }
        await vscode.commands.executeCommand('vscode.open', uri);
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
      'working-memory.setWorkstreamSection',
      async (arg?: { slug?: string; section?: string }) => {
        const slug = arg?.slug;
        const section = arg?.section;
        if (!slug || !section) {
          vscode.window.showWarningMessage(
            'Working Memory: Move Workstream requires a slug and section.',
          );
          return;
        }
        if (
          section !== 'queue' &&
          section !== 'progress' &&
          section !== 'backlog'
        ) {
          vscode.window.showWarningMessage(
            `Working Memory: invalid section "${section}".`,
          );
          return;
        }
        if (!store) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot move workstream — DB is not available.',
          );
          return;
        }
        try {
          store.updateWorkstream(slug, { status: section });
          refresh();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to move workstream — ${message}`,
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
    vscode.commands.registerCommand(
      'working-memory.alert.editDescription',
      async (arg?: { id?: number }) => {
        await editAlertField(arg?.id, 'description');
      },
    ),
    vscode.commands.registerCommand(
      'working-memory.alert.editAction',
      async (arg?: { id?: number }) => {
        await editAlertField(arg?.id, 'recommended_action');
      },
    ),
    vscode.commands.registerCommand(
      'working-memory.alert.setStatus',
      (arg?: { id?: number; status?: string }) => {
        const id = arg?.id;
        const status = arg?.status;
        if (!id || (status !== 'alert' && status !== 'informational' && status !== 'closed')) {
          return;
        }
        if (!store || !ALERTS_ENABLED) {
          vscode.window.showErrorMessage('Working Memory: alerts unavailable.');
          return;
        }
        try {
          new AlertsStore(store.connection).updateAlert(id, { status });
          refresh();
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(`Working Memory: ${m}`);
        }
      },
    ),
    vscode.commands.registerCommand(
      'working-memory.nanite.delete',
      (arg?: { slug?: string }) => {
        const slug = arg?.slug?.trim();
        if (!slug) {
          vscode.window.showWarningMessage(
            'Working Memory: Delete Nanite requires a slug.',
          );
          return;
        }
        if (!store || !NANITES_ENABLED) {
          vscode.window.showErrorMessage('Working Memory: nanites unavailable.');
          return;
        }
        try {
          new NanitesStore(store.connection).deleteNanite(slug);
          refresh();
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to delete nanite — ${m}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'working-memory.nanite.restore',
      (arg?: { slug?: string }) => {
        const slug = arg?.slug?.trim();
        if (!slug) {
          vscode.window.showWarningMessage(
            'Working Memory: Restore Nanite requires a slug.',
          );
          return;
        }
        if (!store || !NANITES_ENABLED) {
          vscode.window.showErrorMessage('Working Memory: nanites unavailable.');
          return;
        }
        try {
          new NanitesStore(store.connection).restoreNanite(slug);
          refresh();
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to restore nanite — ${m}`,
          );
        }
      },
    ),
    vscode.window.registerWebviewViewProvider(
      WorkstreamPanelProvider.viewType,
      panelProvider,
    ),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        const parts = uri.path.split('/').filter((p) => p.length > 0);
        // Alert action deep links: alert/<id>/<acknowledge|close>. The built-in
        // markdown preview strips command: links, so the alert cards' buttons
        // route through here instead.
        if (parts.length === 3 && parts[0] === 'alert') {
          const id = Number(parts[1]);
          const action = parts[2];
          if (!Number.isInteger(id) || id <= 0) {
            vscode.window.showErrorMessage(
              `Working Memory: unrecognized deep link: ${uri.toString()}`,
            );
            return;
          }
          if (action === 'acknowledge') {
            setAlertStatus(id, 'informational');
          } else if (action === 'close') {
            setAlertStatus(id, 'closed');
          } else if (action === 'reopen') {
            setAlertStatus(id, 'alert');
          } else {
            vscode.window.showErrorMessage(
              `Working Memory: unrecognized deep link: ${uri.toString()}`,
            );
          }
          return;
        }
        if (parts.length !== 3 || parts[0] !== 'open') {
          vscode.window.showErrorMessage(
            `Working Memory: unrecognized deep link: ${uri.toString()}`,
          );
          return;
        }
        const kind = parts[1];
        if (
          kind !== 'session' &&
          kind !== 'topic' &&
          kind !== 'topic-type' &&
          kind !== 'workstream' &&
          kind !== 'alert' &&
          kind !== 'nanite' &&
          kind !== 'nanite-run'
        ) {
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
    vscode.window.tabGroups.onDidChangeTabs(() => pushActiveRevealTarget()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => pushActiveRevealTarget()),
  );

  // Seed the panel with whatever WM doc (if any) is already visible.
  pushActiveRevealTarget();

  // Tools only register when we have a live store — without one there's no
  // useful work for them to do.
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
