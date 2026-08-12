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
import { findHubWorkspace, resolveDbPath } from './paths';
import { WorkstreamDocumentProvider } from './contentProvider';
import { WorkstreamPanelProvider } from './webview/panelProvider';
import { DocumentEditorProvider } from './webview/documentEditorProvider';
import { CommandWidgetProvider } from './webview/commandWidgetProvider';
import {
  resolveRevealFromTabs,
  resolveDocumentIdFromTabs,
  type TabDescriptor,
} from './panelReveal';
import { findLatestVsix } from './vsix';
import { deployTemplates } from './deployTemplates';
import { initControlPlaneIntegration } from './controlPlane';
import { ControlPlaneClient, type Nanite } from './controlPlaneClient';
import { ControlPlaneHost } from './controlPlaneHost';
import { maxMtimeMs } from './storeMtime';
import {
  EXTENSION_HOST_RUNNER_ID,
  ExtensionHostNaniteRunner,
  NaniteDispatcher,
  NaniteRunnerRegistry,
  VscodeLmBridge,
  DevContainer,
  providerFromSettings,
  type NaniteRunResult,
} from './nanites';

/** Authored alert lifecycle status, mirroring the control-plane Alert kind. */
type AlertStatus = 'alert' | 'informational' | 'closed';

let controlPlaneClient: ControlPlaneClient | null = null;
let controlPlaneHost: ControlPlaneHost | null = null;
/**
 * Absolute path to the extension's global storage, captured at activation. Used
 * as the root for per-run nanite dev-container scratch workspaces. Null until
 * `activate` runs (nanites can't execute before that anyway).
 */
let naniteStorageDir: string | null = null;

/**
 * The extension's SecretStorage, captured at activation. Holds the repo-scoped
 * GitHub PAT that gets injected into nanite dev containers. Null until
 * `activate` runs.
 */
let extensionSecrets: vscode.SecretStorage | null = null;

/** SecretStorage key for the nanite dev-container GitHub token. */
const GITHUB_TOKEN_SECRET_KEY = 'workingMemory.githubToken';

/**
 * Read the repo-scoped GitHub PAT from SecretStorage (set via the
 * `workingMemory.setGithubToken` command). This is the credential injected into
 * a nanite's dev container as `GH_TOKEN` so it can clone/branch/push/open PRs.
 * Returns null when no token is stored — the container is then brought up
 * without credentials and GitHub ops fail with GitHub's own auth error, which
 * is acceptable for now (we never fabricate a broad session token).
 */
async function readStoredGithubToken(): Promise<string | null> {
  try {
    const value = await extensionSecrets?.get(GITHUB_TOKEN_SECRET_KEY);
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** Read the dispatcher's concurrency cap from settings (>= 1, default 1). */
function naniteMaxConcurrent(): number {
  const raw = vscode.workspace
    .getConfiguration('workingMemory')
    .get<number>('nanites.maxConcurrent', 1);
  return Math.max(1, Math.floor(typeof raw === 'number' ? raw : 1));
}

/**
 * Execute ONE nanite instance through the extension-host runner, resolving its
 * provider from the owning template's execution settings. Shared by the manual
 * Run path and the {@link NaniteDispatcher}.
 */
async function runNaniteInstance(
  client: ControlPlaneClient,
  nanite: Nanite,
): Promise<void> {
  let provider: string | null = null;
  if (nanite.templateId) {
    const [tpl] = await client.naniteTemplateRead({ slug: nanite.templateId });
    const template =
      tpl ?? (await client.naniteTemplateRead({ id: nanite.templateId }))[0];
    provider = providerFromSettings(template?.executionSettings);
  }
  const registry = await buildNaniteRunnerRegistry(client);
  await registry.resolve(provider).run(nanite);
}

/**
 * Build a runner registry with the extension-host runner wired up (per-run
 * GitHub token + dev-container factory + `vscode.lm` bridge). Shared by the
 * dispatcher/manual run path ({@link runNaniteInstance}) and the chat-directed
 * agent path ({@link directAgent}). `postCompletion:false` suppresses the
 * runner's own chat write-back so the agent path can journal under its own
 * scope instead.
 */
async function buildNaniteRunnerRegistry(
  client: ControlPlaneClient,
  opts?: { postCompletion?: boolean },
): Promise<NaniteRunnerRegistry> {
  const registry = new NaniteRunnerRegistry(EXTENSION_HOST_RUNNER_ID);
  // A per-run GitHub token (from SecretStorage) + the container factory, wired
  // only when we know where global storage lives. The bridge is created PER RUN
  // so its per-run `run_command` container reference never straddles two runs.
  const githubToken = await readStoredGithubToken();
  const storageDir = naniteStorageDir;
  const containerFactory = storageDir
    ? (n: Nanite, env: Record<string, string>): DevContainer =>
        new DevContainer({
          id: n.id,
          storageDir,
          // Attributable, non-personal identity for automated commits.
          gitUserName: 'Working Memory Nanite',
          gitUserEmail: 'nanite@working-memory.local',
          // Repo-scoped PAT from SecretStorage; injected as GH_TOKEN +
          // GITHUB_TOKEN. A configmap GH_TOKEN in `env` takes precedence.
          githubToken,
          // Merged configmap data → --remote-env KEY=VALUE (config wins).
          env,
          // Policy: keep the container on failure so a human can attach + debug.
          keepOnFailure: true,
        })
    : undefined;
  registry.register(
    new ExtensionHostNaniteRunner({
      client,
      bridge: new VscodeLmBridge(),
      containerFactory,
      // Redact this token from the persisted run record (value + patterns).
      githubToken,
      postCompletion: opts?.postCompletion,
    }),
  );
  return registry;
}

/**
 * The chat-directed AGENT path (`nanites-as-longlived-chattable-agents`): run a
 * long-lived nanite once with a fresh directive as its request, returning the
 * run result so the caller (the command widget) can journal the exchange under
 * the agent's own scope. Re-directable — a terminal (Succeeded/Failed) agent is
 * reset to Pending before the run; a still-Running agent is refused as busy.
 *
 * NOTE (increment 1): the directive overrides the in-memory `request` used to
 * build the prompt, but the stored `spec.request` is left as-is — the durable
 * record of the back-and-forth is the agent's chat, not the nanite doc.
 */
async function directAgent(
  client: ControlPlaneClient,
  naniteId: string,
  directive: string,
): Promise<NaniteRunResult> {
  const [nanite] = await client.naniteRead({ id: naniteId });
  if (!nanite) {
    throw new Error(`No agent with id ${naniteId.slice(0, 8)}.`);
  }
  if (nanite.phase === 'Running') {
    throw new Error('This agent is busy with another directive — wait for it to finish.');
  }
  // A terminal (or otherwise non-runnable) agent must return to Pending before
  // the runner's `begin` will start it. Pending/Queued can start as-is.
  let ready = nanite;
  if (nanite.phase !== 'Pending' && nanite.phase !== 'Queued') {
    const reset = await client.naniteRun({ id: naniteId, reset: true });
    ready = reset ?? nanite;
  }
  let provider: string | null = null;
  if (ready.templateId) {
    const [tpl] = await client.naniteTemplateRead({ slug: ready.templateId });
    const template =
      tpl ?? (await client.naniteTemplateRead({ id: ready.templateId }))[0];
    provider = providerFromSettings(template?.executionSettings);
  }
  const registry = await buildNaniteRunnerRegistry(client, { postCompletion: false });
  return registry.resolve(provider).run({ ...ready, request: directive });
}

// Last-seen newest mtime across the control-plane store files, used by the
// panel auto-refresh poll backstop (feature:panel-auto-refresh).
let lastMtimeMs = 0;

type TopicAddToWorkstreamCommandInput = {
  topicSlug?: string;
  traversalId?: string;
  workstreamSlug?: string;
};

type TopicRemoveFromWorkstreamCommandInput = {
  topicSlug?: string;
  workstreamSlug?: string;
};

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
  // Root for per-run nanite dev-container scratch workspaces.
  naniteStorageDir = context.globalStorageUri.fsPath;
  // SecretStorage holding the repo-scoped GitHub PAT injected into containers.
  extensionSecrets = context.secrets;
  // Register the FileSystemProvider for the working-memory: scheme
  // synchronously and first — before any DB access — so that restored
  // Markdown Preview webview editors can resolve working-memory: URIs
  // during the startup restore race.  The onFileSystem:working-memory
  // activation event fires before onStartupFinished when a
  // working-memory: URI is already open, giving the preview webview a
  // live provider to call into.  The provider degrades gracefully while
  // store is null (returns placeholder content) and is updated with the
  // real store once the DB opens below.
  const contentProvider = new WorkstreamDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(
      WorkstreamDocumentProvider.scheme,
      contentProvider,
      { isCaseSensitive: true, isReadonly: false },
    ),
  );

  // Own the control-plane PROCESS (WM 13.0 "control-plane-hosting-modes").
  // Depending on the resolved hosting mode (auto/embedded/service) this either
  // spawns + supervises the daemon (embedded / auto-with-no-service) or stays a
  // pure client (service / auto-with-running-service). Constructed BEFORE the
  // MCP client + registration so both can source the endpoint port from the
  // host it authoritatively owns (embedded child's reported port, or the
  // configured service port) rather than the shared discovery port file.
  controlPlaneHost = new ControlPlaneHost(context);
  const host = controlPlaneHost;

  // MCP client for the control-plane document store (WM 13.0 "blackboard-tab").
  // Reads documents through the same `/mcp` surface an agent uses, so the
  // Blackboard tab + the unified `.working-memory` custom editor exercise the
  // real tool path. Best-effort: no-ops when the daemon isn't running.
  // Sources its URL from the host's OWNED port so it always talks to the same
  // daemon the MCP registration points chat at — never the shared port file.
  controlPlaneClient = new ControlPlaneClient({
    resolveUrl: () => {
      const port = host.endpointPort;
      return port === undefined ? null : `http://127.0.0.1:${port}/mcp`;
    },
    // Best-effort observability: the MCP SDK keeps a standalone SSE stream open
    // for notifications; when the daemon restarts/dies that stream errors here.
    // Log at debug (Extension Host output) instead of dropping it silently.
    onError: (err) =>
      console.debug('[working-memory] control-plane transport error:', err),
  });

  // Start supervising/probing now that the client is wired to its owned port.
  // Best-effort: start() never throws into activation.
  void controlPlaneHost.start();

  // Deploy the bundled templates into the hub workspace (best-effort). This is
  // independent of any data plane — it just refreshes on-disk template assets.
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
  const panelProvider = new WorkstreamPanelProvider(
    context.extensionUri,
    controlPlaneClient,
  );

  // The unified Svelte document custom editor (WM 14.2). Reads/writes documents
  // THROUGH the control-plane client (never the DB); dispatches its UI by kind
  // (workstream / topic / generic fallback). Opened via a synthetic
  // `working-memory:/<kind>/<id>.working-memory` URI from the panel rail.
  const documentEditorProvider = new DocumentEditorProvider(
    context.extensionUri,
    () => controlPlaneClient,
  );
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      DocumentEditorProvider.viewType,
      documentEditorProvider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    ),
  );

  // The right-rail command widget (WM 14.2.1 "poc-right-rail-command-widget").
  // A second webview view in the Working Memory container that drives WM CRUD by
  // handing a natural-language command to a LOCAL model tool-calling loop, all
  // through the control-plane client (never SQLite). Michael can drag it into
  // the secondary side bar. Reads the live client through the same accessor the
  // document editor uses so it always talks to the currently-connected daemon.
  const commandWidgetProvider = new CommandWidgetProvider(
    context.extensionUri,
    () => controlPlaneClient,
    (naniteId, directive) =>
      directAgent(controlPlaneClient as ControlPlaneClient, naniteId, directive),
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CommandWidgetProvider.viewType,
      commandWidgetProvider,
    ),
  );

  const refresh = (): void => {
    panelProvider.refresh();
    contentProvider.refresh();
    // Re-fetch + re-push any open document editors so they live-update on
    // external store writes (Bug A) and self-heal from "connecting…" once the
    // control-plane daemon is up (Bug B). Rides the same debounced signal.
    void documentEditorProvider.refreshOpen();
  };

  // The nanite EXECUTION DISPATCHER — the centralized execution plane. Polls the
  // control plane for `Queued` nanites and runs them through the extension-host
  // runner, throttled to `workingMemory.nanites.maxConcurrent` (default 1).
  const naniteDispatcher = new NaniteDispatcher({
    readClient: () => controlPlaneClient,
    run: (nanite) => runNaniteInstance(controlPlaneClient as ControlPlaneClient, nanite),
    maxConcurrent: naniteMaxConcurrent,
    onChange: refresh,
  });
  naniteDispatcher.start();
  context.subscriptions.push({ dispose: () => naniteDispatcher.dispose() });

  // Ensure the built-in default topic type exists in the control plane so a
  // topic's default `topicType: 'topic'` resolves to a real type (shape icon)
  // and shows in the Topic Types tab. Idempotent + best-effort; retries on the
  // next ready signal if the control plane isn't reachable yet.
  let defaultsEnsured = false;
  const ensureDefaultTopicTypes = async (): Promise<void> => {
    if (defaultsEnsured || !controlPlaneClient) {
      return;
    }
    try {
      const existing = await controlPlaneClient.topicTypeRead({});
      const have = new Set(existing.map((t) => t.slug));
      if (!have.has('topic')) {
        await controlPlaneClient.topicTypeCreate({
          slug: 'topic',
          label: 'Topic',
          icon: 'symbol-key',
          description: 'A general note or subject — the default topic type.',
        });
      }
      defaultsEnsured = true;
    } catch {
      // Best-effort: a control-plane hiccup must never break activation.
    }
  };

  // Wire the WM 13.0 control-plane: register its MCP server with Copilot once
  // the daemon's port file appears, and install the wm2 chat mode in the
  // sandbox. Independent of the journal DB and self-guarding, so it runs here
  // regardless of hub/DB state. Passing `refresh` lets the readiness poll nudge
  // the control-plane-backed panel tabs once the daemon's port file appears, so
  // the panel populates without a manual refresh on first load.
  initControlPlaneIntegration(context, controlPlaneHost, () => {
    refresh();
    void ensureDefaultTopicTypes().then(refresh);
    // Drain any nanites that were Queued while the daemon was down.
    void naniteDispatcher.pump();
  });

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

  const setControlPlaneAlertStatus = async (
    id: string,
    status: AlertStatus,
  ): Promise<void> => {
    if (!controlPlaneClient) {
      vscode.window.showErrorMessage('Working Memory: alerts unavailable.');
      return;
    }
    try {
      await controlPlaneClient.alertUpdate({ id, status });
      refresh();
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Working Memory: ${m}`);
    }
  };

  // Derive the visible WM doc from tabGroups, not window.activeTextEditor:
  // the latter goes undefined when the WM webview takes focus. WM docs open in
  // the unified custom editor (`workingMemory.documentEditor`), which surfaces
  // as a `vscode.TabInputCustom` carrying the source `working-memory:` URI.
  const classifyTab = (tab: vscode.Tab | undefined): TabDescriptor => {
    const input = tab?.input;
    if (input instanceof vscode.TabInputCustom) {
      // uri.path is already percent-decoded.
      return {
        kind: 'custom',
        scheme: input.uri.scheme,
        path: input.uri.path,
        viewType: input.viewType,
      };
    }
    return { kind: 'other' };
  };

  // Monotonic token guarding the async nanite-scope resolution below against
  // out-of-order completion when the active tab changes rapidly.
  let revealScopeToken = 0;
  const pushActiveRevealTarget = (): void => {
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const tab = classifyTab(activeTab);
    const target = resolveRevealFromTabs(tab);
    panelProvider.reveal(target);
    // Sticky context for the command widget: mirror the same active-tab signal.
    // A topic/workstream target is directly a command scope.
    if (target && (target.kind === 'topic' || target.kind === 'workstream')) {
      commandWidgetProvider.setContext({ slug: target.id, kind: target.kind });
      return;
    }
    // Slug-less docs (nanites/agents) open via the generic by-id route
    // (`working-memory:/document/<id>`), so the reveal parser can't classify
    // them by kind. If the active tab is such a doc, resolve its kind through
    // the control plane: `ws-nanite-read` is kind-scoped, so a hit means the
    // doc is a Nanite → scope the widget to that agent (mirroring the
    // topic/workstream branch). Anything else clears the scope. A monotonic
    // token drops stale async results from rapid tab switches.
    const docId = resolveDocumentIdFromTabs(tab);
    const client = controlPlaneClient;
    if (docId && client) {
      const token = ++revealScopeToken;
      void (async () => {
        try {
          const [nanite] = await client.naniteRead({ id: docId });
          if (token !== revealScopeToken) {
            return;
          }
          commandWidgetProvider.setContext(
            nanite ? { slug: docId, kind: 'nanite' } : null,
          );
        } catch {
          if (token === revealScopeToken) {
            commandWidgetProvider.setContext(null);
          }
        }
      })();
      return;
    }
    commandWidgetProvider.setContext(null);
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
    vscode.commands.registerCommand('workingMemory.setGithubToken', async () => {
      const token = await vscode.window.showInputBox({
        title: 'Working Memory: Set GitHub Token for Nanites',
        prompt:
          'Paste a repo-scoped fine-grained GitHub PAT (Contents + Pull requests: read/write). Leave blank to clear the stored token.',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'github_pat_… (blank to clear)',
      });
      if (token === undefined) {
        return; // cancelled — leave the stored value untouched.
      }
      if (token.trim() === '') {
        await extensionSecrets?.delete(GITHUB_TOKEN_SECRET_KEY);
        vscode.window.showInformationMessage(
          'Working Memory: nanite GitHub token cleared.',
        );
        return;
      }
      await extensionSecrets?.store(GITHUB_TOKEN_SECRET_KEY, token.trim());
      vscode.window.showInformationMessage(
        'Working Memory: nanite GitHub token saved.',
      );
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
            ['topic', 'topic-type', 'workstream', 'alert'],
            { placeHolder: 'Kind of working-memory doc to open' },
          );
          if (!pickedKind) {
            return;
          }
          kind = pickedKind;
          id = await vscode.window.showInputBox({
            prompt: `Enter ${kind} slug/id`,
          });
          if (!id) {
            return;
          }
        }
        if (
          kind !== 'topic' &&
          kind !== 'topic-type' &&
          kind !== 'workstream' &&
          kind !== 'alert'
        ) {
          vscode.window.showWarningMessage(
            `Working Memory: unknown kind "${kind}" (expected topic|topic-type|workstream|alert).`,
          );
          return;
        }
        // WM 14.2.1: EVERY Working Memory document kind opens in the unified
        // Svelte custom editor (`workingMemory.documentEditor`) via a synthetic
        // `working-memory:/<kind>/<id>.working-memory` URI. Kinds without a
        // bespoke view (topic-type, alert) render through the editor's generic
        // `DocumentView` fallback. There is no longer a `.md` virtual-doc route.
        //
        // TODO(wm-14.2.1): the old markdown route supported a heading reveal
        // (`revealSection` → scroll to ## Sessions / ## Recent entries). The
        // Svelte editor has no markdown headings to scroll to, so
        // `revealSection` is now ignored — the document just opens. Re-add an
        // in-editor section reveal when the editor grows anchored sections.
        void revealSection;
        await vscode.commands.executeCommand(
          'vscode.openWith',
          DocumentEditorProvider.uriFor(kind, id),
          DocumentEditorProvider.viewType,
        );
      },
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
      'workingMemory.nanite.run',
      async (arg?: { id?: string }) => {
        const id = arg?.id?.trim();
        if (!id) {
          vscode.window.showWarningMessage(
            'Working Memory: Run Nanite requires a nanite id.',
          );
          return;
        }
        if (!controlPlaneClient) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot run nanite — control plane is not running.',
          );
          return;
        }
        const client = controlPlaneClient;
        try {
          const [nanite] = await client.naniteRead({ id });
          if (!nanite) {
            vscode.window.showErrorMessage(
              `Working Memory: no nanite with id ${id.slice(0, 8)}.`,
            );
            return;
          }
          if (nanite.phase === 'Running' || nanite.phase === 'Queued') {
            // Already in the execution plane — just nudge the dispatcher.
            void naniteDispatcher.pump();
            vscode.window.showInformationMessage(
              `Working Memory: nanite ${id.slice(0, 8)} already ${nanite.phase.toLowerCase()}.`,
            );
            return;
          }
          if (nanite.phase !== 'Pending') {
            vscode.window.showInformationMessage(
              `Working Memory: nanite ${id.slice(0, 8)} already ${nanite.phase.toLowerCase()} — use Restart to re-run.`,
            );
            return;
          }
          // Human approval: enqueue for the dispatcher (the centralized
          // execution plane), which starts it (Queued → Running) and runs it.
          await client.naniteRun({ id, approved: true });
          refresh();
          void naniteDispatcher.pump();
          vscode.window.showInformationMessage(
            `Working Memory: nanite ${id.slice(0, 8)} queued.`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to run nanite — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'workingMemory.nanite.reset',
      async (arg?: { id?: string }) => {
        const id = arg?.id?.trim();
        if (!id) {
          vscode.window.showWarningMessage(
            'Working Memory: Reset Nanite requires a nanite id.',
          );
          return;
        }
        if (!controlPlaneClient) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot reset nanite — control plane is not running.',
          );
          return;
        }
        try {
          await controlPlaneClient.naniteRun({ id, reset: true });
          refresh();
          vscode.window.showInformationMessage(
            `Working Memory: nanite ${id.slice(0, 8)} reset to Pending.`,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to reset nanite — ${message}`,
          );
        }
      },
    ),
    vscode.commands.registerCommand(
      'workingMemory.nanite.restart',
      async (arg?: { id?: string }) => {
        const id = arg?.id?.trim();
        if (!id) {
          vscode.window.showWarningMessage(
            'Working Memory: Restart Nanite requires a nanite id.',
          );
          return;
        }
        if (!controlPlaneClient) {
          vscode.window.showErrorMessage(
            'Working Memory: cannot restart nanite — control plane is not running.',
          );
          return;
        }
        try {
          // Reset to Pending, then run — the run command reads it fresh.
          await controlPlaneClient.naniteRun({ id, reset: true });
          refresh();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          vscode.window.showErrorMessage(
            `Working Memory: failed to restart nanite — ${message}`,
          );
          return;
        }
        await vscode.commands.executeCommand('workingMemory.nanite.run', { id });
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
      'working-memory.alert.setStatus',
      (arg?: { id?: string | number; status?: string }) => {
        const rawId = arg?.id;
        const status = arg?.status;
        if (
          rawId === undefined ||
          (status !== 'alert' && status !== 'informational' && status !== 'closed')
        ) {
          return;
        }
        void setControlPlaneAlertStatus(String(rawId), status);
      },
    ),
    vscode.window.registerWebviewViewProvider(
      WorkstreamPanelProvider.viewType,
      panelProvider,
    ),
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        const parts = uri.path.split('/').filter((p) => p.length > 0);
        // Alert action deep links: alert/<id>/<acknowledge|close|reopen>. The
        // built-in markdown preview strips command: links, so the alert cards'
        // buttons route through here instead. `<id>` is the control-plane alert
        // id; the mutation flows through the control-plane client.
        if (parts.length === 3 && parts[0] === 'alert') {
          const rawId = parts[1];
          const action = parts[2];
          let status: AlertStatus;
          if (action === 'acknowledge') {
            status = 'informational';
          } else if (action === 'close') {
            status = 'closed';
          } else if (action === 'reopen') {
            status = 'alert';
          } else {
            vscode.window.showErrorMessage(
              `Working Memory: unrecognized deep link: ${uri.toString()}`,
            );
            return;
          }
          void setControlPlaneAlertStatus(rawId, status);
          return;
        }
        // Nanite action deep links: nanite/<id>/run — the doc's "Approve & Run"
        // button (markdown preview strips command: links). Routes through the
        // Run command, which is the human-approval enqueue.
        if (parts.length === 3 && parts[0] === 'nanite') {
          const rawId = parts[1];
          if (parts[2] === 'run') {
            void vscode.commands.executeCommand('workingMemory.nanite.run', { id: rawId });
            return;
          }
          vscode.window.showErrorMessage(
            `Working Memory: unrecognized deep link: ${uri.toString()}`,
          );
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
          kind !== 'topic' &&
          kind !== 'topic-type' &&
          kind !== 'workstream' &&
          kind !== 'alert'
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

  // Populate the control-plane-backed panel on first load.
  refresh();
}

export function deactivate(): void {
  // Close the control-plane CLIENT before killing the daemon. The MCP SDK's
  // Streamable-HTTP transport keeps an open SSE/HTTP stream; disposing the
  // client aborts it cleanly. If we killed the daemon first (host.dispose),
  // that death would RST the in-flight undici stream and surface as an
  // unhandled "TypeError: terminated" (a dependency-level rejection with no
  // frames of ours). Order matters — client first, then host.
  try {
    if (controlPlaneClient) {
      void controlPlaneClient.dispose();
      controlPlaneClient = null;
    }
  } catch (err) {
    console.error('[working-memory] control-plane client dispose failed:', err);
  }
  try {
    if (controlPlaneHost) {
      controlPlaneHost.dispose();
      controlPlaneHost = null;
    }
  } catch (err) {
    console.error('[working-memory] control-plane host dispose failed:', err);
  }
}
