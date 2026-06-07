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
