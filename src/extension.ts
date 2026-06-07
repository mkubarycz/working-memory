import * as vscode from 'vscode';
import { openDb, closeDb, getDbPath, reopenWorkstream } from './db';
import { WorkstreamDocumentProvider } from './contentProvider';
import { registerTools } from './tools';
import { WorkstreamPanelProvider } from './webview/panelProvider';

export function activate(context: vscode.ExtensionContext): void {
  const panelProvider = new WorkstreamPanelProvider(context.extensionUri);
  const contentProvider = new WorkstreamDocumentProvider();

  const refresh = (): void => {
    panelProvider.refresh();
    contentProvider.refresh();
  };

  // Register commands, the webview view provider, and the virtual-doc
  // provider FIRST so the title-bar actions and click-to-open work even if
  // the DB layer fails to load for any reason. The db.ts helpers guard on a
  // missing DB and return empty results, so the virtual docs degrade
  // gracefully.
  context.subscriptions.push(
    vscode.commands.registerCommand('working-memory.refresh', refresh),
    vscode.commands.registerCommand('working-memory.reloadWindow', () => {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
    // Open a virtual doc by kind + id. Used primarily for chat-rendered
    // `command:` links (VS Code's chat panel strips custom URI schemes like
    // `working-memory:` but honors `command:` URIs). The content provider
    // handles missing/invalid ids by rendering its own not-found body, so
    // we don't validate here — parity with row clicks in the panel.
    vscode.commands.registerCommand(
      'working-memory.open',
      async (arg?: { kind?: string; id?: string } | string, maybeId?: string) => {
        // Tolerate two shapes: ({kind,id}) from chat markdown args, or
        // (kind, id) from a manual executeCommand call.
        let kind: string | undefined;
        let id: string | undefined;
        if (typeof arg === 'string') {
          kind = arg;
          id = maybeId;
        } else if (arg && typeof arg === 'object') {
          kind = arg.kind;
          id = arg.id;
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
        await vscode.commands.executeCommand('vscode.open', uri);
      },
    ),
    // Discoverable shortcuts — each delegates to the consolidated command
    // above so there's one code path. These are what shows up in the
    // Command Palette as "Working Memory: Open Session/Topic/Workstream".
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
      'working-memory.reopenWorkstream',
      async (arg?: { slug?: string; workstream?: { slug?: string } }) => {
        const slug = arg?.slug ?? arg?.workstream?.slug;
        if (!slug) {
          vscode.window.showWarningMessage(
            'Working Memory: Reopen Workstream requires a workstream slug.',
          );
          return;
        }
        try {
          const updated = reopenWorkstream(slug);
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
    // Deep-link handler — `vscode://kubarycz.working-memory/open/<kind>/<id>`.
    // Copilot Chat renders these as clickable links in assistant output
    // (unlike `command:` URIs, which require trusted markdown). We route
    // through the existing `working-memory.open` command so there's one
    // code path. Bogus slugs/uuids fall through to the content provider's
    // not-found body — only malformed paths produce a notification.
    vscode.window.registerUriHandler({
      handleUri(uri: vscode.Uri): void {
        const parts = uri.path.split('/').filter((p) => p.length > 0);
        // Expect ['open', '<kind>', '<id>'] — note `<id>` may contain
        // additional slashes, but slugs/uuids don't, so we treat anything
        // beyond 3 parts as malformed.
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

  // Register LM tools BEFORE opening the DB. Each tool handler checks
  // `isDbOpen()` at invoke-time and returns a structured error result rather
  // than throwing, so Copilot can surface the failure cleanly even if
  // activation reached this point with no usable DB.
  registerTools(context, { refresh });

  // Now try to open the DB. Any failure here is surfaced but non-fatal:
  // the view will simply be empty until the underlying issue is resolved.
  try {
    const db = openDb(context.extensionPath);
    if (!db) {
      vscode.window.showWarningMessage(
        'Working Memory: no hub workspace found (need a folder with AGENTS.md and a memory/ directory). The Workstreams panel will be empty.',
      );
    } else {
      console.log(`[working-memory] DB opened at ${getDbPath()}`);
      refresh();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[working-memory] openDb failed:', err);
    vscode.window.showErrorMessage(
      `Working Memory: failed to open journal DB — ${message}. Title-bar actions still work; try 'Working Memory: Reload Window' after investigating.`,
    );
  }
}

export function deactivate(): void {
  try {
    closeDb();
  } catch (err) {
    console.error('[working-memory] closeDb failed:', err);
  }
}
