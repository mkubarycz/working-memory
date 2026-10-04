import * as vscode from 'vscode';
import { initControlPlaneIntegration } from './controlPlane';
import { ControlPlaneHost } from './controlPlaneHost';
import { launchDesktopDeepLink, launchDesktopUi } from './desktopLauncher';

let controlPlaneHost: ControlPlaneHost | null = null;

export function activate(context: vscode.ExtensionContext): void {
  controlPlaneHost = new ControlPlaneHost(context);
  void controlPlaneHost.start();
  initControlPlaneIntegration(context, controlPlaneHost);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'working-memory.openDesktopUi',
      async () => {
        try {
          await launchDesktopUi(context.extensionPath);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(
            `Working Memory: failed to open desktop app — ${message}`,
          );
        }
      },
    ),
    vscode.window.registerUriHandler({
      handleUri(uri): void {
        const parts = uri.path.split('/').filter(Boolean);
        if (parts.length !== 3 || parts[0] !== 'open') {
          vscode.window.showErrorMessage(
            `Working Memory: unrecognized deep link: ${uri.toString()}`,
          );
          return;
        }
        const kind = parts[1];
        if (!['topic', 'topic-type', 'workstream', 'alert', 'document'].includes(kind)) {
          vscode.window.showErrorMessage(
            `Working Memory: unrecognized deep link: ${uri.toString()}`,
          );
          return;
        }
        let identifier: string;
        try {
          identifier = decodeURIComponent(parts[2]);
        } catch {
          vscode.window.showErrorMessage(
            `Working Memory: unrecognized deep link: ${uri.toString()}`,
          );
          return;
        }
        void launchDesktopDeepLink(context.extensionPath, kind, identifier).catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          vscode.window.showErrorMessage(
            `Working Memory: failed to open desktop link — ${message}`,
          );
        });
      },
    }),
  );
}

export function deactivate(): void {
  controlPlaneHost?.dispose();
  controlPlaneHost = null;
}
