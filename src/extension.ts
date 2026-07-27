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
import { registerWorkingMemoryChatSession } from './chatSession';
import { WorkstreamPanelProvider } from './webview/panelProvider';
import {
  isMarkdownPreviewViewType,
  resolveRevealFromTabs,
  type TabDescriptor,
  type PanelRevealTarget,
} from './panelReveal';
import { findLatestVsix } from './vsix';
import { deployTemplates } from './deployTemplates';
import { type TraversalModeId } from './graphTraversals';
import { initControlPlaneIntegration } from './controlPlane';
import { ControlPlaneClient } from './controlPlaneClient';
import { ControlPlaneHost } from './controlPlaneHost';
import { maxMtimeMs } from './storeMtime';

let activeStore: JournalStore | null = null;
let controlPlaneClient: ControlPlaneClient | null = null;
let controlPlaneHost: ControlPlaneHost | null = null;
// Last-seen newest mtime across the control-plane store files, used by the
// panel auto-refresh poll backstop (feature:panel-auto-refresh).
let lastMtimeMs = 0;

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

  // MCP client for the control-plane document store (WM 13.0 "blackboard-tab").
  // Reads documents through the same `/mcp` surface an agent uses, so the
  // Blackboard tab + `working-memory:/document/<id>.md` virtual docs exercise
  // the real tool path. Best-effort: no-ops when the daemon isn't running.
  controlPlaneClient = new ControlPlaneClient();
  contentProvider.setControlPlaneClient(controlPlaneClient);

  // Own the control-plane PROCESS (WM 13.0 "control-plane-hosting-modes").
  // Depending on the resolved hosting mode (auto/embedded/service) this either
  // spawns + supervises the daemon (embedded / auto-with-no-service) or stays a
  // pure client (service / auto-with-running-service). Started before the MCP
  // registration below so the port file is more likely to exist when discovery
  // polls. Best-effort: start() never throws into activation.
  controlPlaneHost = new ControlPlaneHost(context);
  void controlPlaneHost.start();

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
    controlPlaneClient,
  );

  const refresh = (): void => {
    panelProvider.refresh();
    contentProvider.refresh();
  };

  // Wire the WM 13.0 control-plane: register its MCP server with Copilot once
  // the daemon's port file appears, and install the wm2 chat mode in the
  // sandbox. Independent of the journal DB and self-guarding, so it runs here
  // regardless of hub/DB state. Passing `refresh` lets the readiness poll nudge
  // the control-plane-backed panel tabs once the daemon's port file appears, so
  // the panel populates without a manual refresh on first load.
  initControlPlaneIntegration(context, refresh);

  // Auto-refresh the panel when the control-plane daemon mutates its store
  // out-of-process. WHY: the control-plane runs as a SEPARATE daemon process.
  // The `refresh` closure above only fires for changes the extension itself
  // initiates (panel drag/drop, legacy wm_* journal tools). When an agent or
  // chat mutates data through the ws-* control-plane tools, those writes hit
  // the daemon directly and the extension never learns of them — so the panel
  // stayed stale until a manual refresh. Watching the daemon's SQLite files
  // (`journal.sqlite`, plus `-wal`/`-shm` in WAL mode) catches every write,
  // including out-of-process ones: OS-level file notifications are
  // process-agnostic. An explicit-base RelativePattern is the supported way to
  // watch a path OUTSIDE the workspace (the store home is typically app-data).
  // `refresh()` is idempotent and never writes the DB, so there's no loop.
  try {
    const storeHome = controlPlaneHost.storeHome;
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(storeHome), 'journal.sqlite*'),
    );
    // Debounce: a single logical write fires a burst of file events (WAL +
    // shm + the main db), so coalesce them into one refresh.
    let debounceTimer: NodeJS.Timeout | undefined;
    const scheduleRefresh = (): void => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        refresh();
      }, 250);
    };
    watcher.onDidChange(scheduleRefresh);
    watcher.onDidCreate(scheduleRefresh);
    watcher.onDidDelete(scheduleRefresh);

    // Reliability backstop: a VS Code FileSystemWatcher on a path OUTSIDE the
    // workspace (the daemon's app-data store dir) is best-effort — VS Code can
    // silently stop delivering change events, which strands the panel until a
    // manual refresh ("worked then stopped"). Poll the store's mtime directly
    // on a timer as a guaranteed fallback that depends on neither the watcher
    // nor a daemon round-trip. In WAL mode writes land in `-wal` while the main
    // db file only changes on checkpoint, so we stat both and track the newest.
    // Both the watcher and the poll feed the SAME debounced scheduleRefresh, so
    // they coalesce into a single refresh rather than doubling up.
    const watchedFiles = [
      join(storeHome, 'journal.sqlite-wal'),
      join(storeHome, 'journal.sqlite'),
    ];
    // Seed from the current state so the first tick doesn't spuriously refresh.
    lastMtimeMs = maxMtimeMs(watchedFiles);
    const pollTimer = setInterval(() => {
      try {
        const current = maxMtimeMs(watchedFiles);
        if (current > lastMtimeMs) {
          lastMtimeMs = current;
          scheduleRefresh();
        }
      } catch (err) {
        // A transient stat error must never escape the interval callback.
        console.error('[working-memory] control-plane store mtime poll failed:', err);
      }
    }, 2000);

    context.subscriptions.push(watcher, {
      dispose: () => {
        clearInterval(pollTimer);
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = undefined;
        }
      },
    });
  } catch (err) {
    // A watcher problem must never break activation.
    console.error('[working-memory] control-plane store watcher setup failed:', err);
  }

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
    // Repointed onto the control-plane ws-workstream-* domain API (WM 13.0):
    // pick from the live (non-closed) control-plane workstreams.
    if (!controlPlaneClient) {
      return null;
    }
    let rows;
    try {
      rows = (await controlPlaneClient.wsRead({})).filter(
        (w) => w.status !== 'closed',
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Working Memory: failed to list workstreams — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (rows.length === 0) {
      vscode.window.showWarningMessage(
        'Working Memory: no open workstreams available.',
      );
      return null;
    }
    const pick = await vscode.window.showQuickPick(
      rows.map((ws) => ({
        label: ws.title,
        description: ws.slug ?? undefined,
        slug: ws.slug ?? '',
      })),
      { placeHolder: 'Choose a workstream' },
    );
    return pick?.slug ?? null;
  };

  const pickLinkedWorkstreamSlug = async (
    topicSlug: string,
  ): Promise<string | null> => {
    // Repointed onto the control-plane ws-topic-* domain API (WM 13.0
    // "topic-consumer-repoint"): the topic's `spec.workstreams` membership is
    // the set to remove from; titles are resolved from the workstream list.
    if (!controlPlaneClient) {
      return null;
    }
    let memberSlugs: string[];
    let titleBySlug: Map<string, string>;
    try {
      const found = await controlPlaneClient.topicRead({ slug: topicSlug });
      memberSlugs = found[0]?.workstreams ?? [];
      const workstreams = await controlPlaneClient.wsRead({});
      titleBySlug = new Map(workstreams.map((w) => [w.slug ?? '', w.title]));
    } catch (err) {
      vscode.window.showErrorMessage(
        `Working Memory: failed to read topic workstreams — ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    if (memberSlugs.length === 0) {
      vscode.window.showWarningMessage(
        `Working Memory: topic "${topicSlug}" is not linked to any workstream.`,
      );
      return null;
    }
    const pick = await vscode.window.showQuickPick(
      memberSlugs.map((slug) => ({
        label: titleBySlug.get(slug) ?? slug,
        description: slug,
        slug,
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
        // Repointed onto the control-plane ws-topic-* domain API via the client
        // (WM 13.0 "topic-consumer-repoint"): attach = add the workstream slug to
        // the topic's `spec.workstreams` membership.
        // TODO: graph TRAVERSAL (attach a topic + its family) has no control-plane
        // equivalent yet (DEFERRED) — the `traversalId` arg is ignored; this
        // attaches the single topic only.
        if (!controlPlaneClient) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot add topic to workstream — control plane is not running.',
          );
          return;
        }
        const workstreamSlug =
          arg?.workstreamSlug?.trim() || await pickOpenWorkstreamSlug();
        if (!workstreamSlug) {
          return;
        }
        try {
          await controlPlaneClient.topicAttachWorkstream({
            slug: topicSlug,
            workstream: workstreamSlug,
          });
          refresh();
          vscode.window.showInformationMessage(
            `Working Memory: linked "${topicSlug}" to "${workstreamSlug}".`,
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
        if (!controlPlaneClient) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot remove topic from workstream — control plane is not running.',
          );
          return;
        }
        const workstreamSlug =
          arg?.workstreamSlug?.trim() || await pickLinkedWorkstreamSlug(topicSlug);
        if (!workstreamSlug) {
          return;
        }
        try {
          // Detach = remove the workstream slug from the topic's membership
          // (idempotent — a no-op if it wasn't a member).
          await controlPlaneClient.topicDetachWorkstream({
            slug: topicSlug,
            workstream: workstreamSlug,
          });
          refresh();
          vscode.window.showInformationMessage(
            `Working Memory: removed "${topicSlug}" from "${workstreamSlug}".`,
          );
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
        // Repointed onto the control-plane ws-* domain API via the client (WM
        // 13.0 "ws-consumer-repoint"): a section move is a lifecycle-status
        // patch.
        if (!controlPlaneClient) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot move workstream — control plane is not running.',
          );
          return;
        }
        try {
          await controlPlaneClient.wsUpdate({ slug, status: section });
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
        // Repointed onto the control-plane ws-* domain API via the client (WM
        // 13.0 "ws-consumer-repoint"): reopen = move the workstream back to an
        // active lifecycle section (progress).
        if (!controlPlaneClient) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot reopen — control plane is not running.',
          );
          return;
        }
        try {
          const updated = await controlPlaneClient.wsUpdate({
            slug,
            status: 'progress',
          });
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
    registerTools(context, store, controlPlaneClient, { refresh });
    // Prototype: Working Memory "capture" chat-session type (proposed API).
    // No-op when the proposed API isn't enabled.
    registerWorkingMemoryChatSession(context, store);
    refresh();
  }
}

export function deactivate(): void {
  try {
    if (controlPlaneHost) {
      controlPlaneHost.dispose();
      controlPlaneHost = null;
    }
  } catch (err) {
    console.error('[working-memory] control-plane host dispose failed:', err);
  }
  try {
    if (controlPlaneClient) {
      void controlPlaneClient.dispose();
      controlPlaneClient = null;
    }
  } catch (err) {
    console.error('[working-memory] control-plane client dispose failed:', err);
  }
  try {
    if (activeStore) {
      activeStore.close();
      activeStore = null;
    }
  } catch (err) {
    console.error('[working-memory] store.close failed:', err);
  }
}
