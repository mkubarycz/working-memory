/**
 * Control-plane integration (WM 13.0 "f5-wiring").
 *
 * Two responsibilities, both best-effort and non-fatal to activation:
 *  1. Register the control-plane's localhost Streamable-HTTP endpoint as an MCP
 *     server so Copilot chat picks up the `wm_*` document tools. The endpoint
 *     port comes from the {@link ControlPlaneHost} — the authoritative owner of
 *     the port we spawned (embedded) or the configured service port (service /
 *     auto-as-client) — NOT from the shared discovery port file, which two
 *     racing daemons can cross.
 *  2. Install the `wm2` chat mode into the sandbox workspace (dev + sandbox
 *     only) so Michael can drive the document store from chat.
 *
 * The MCP server-definition API (`vscode.lm.registerMcpServerDefinitionProvider`
 * + `vscode.McpHttpServerDefinition`) was finalized in VS Code 1.101. The repo
 * pins `@types/vscode` older than that, so the API is reached via feature-
 * detected casts: if the running VS Code lacks it we log and skip rather than
 * throw.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  CONTROL_PLANE_PROVIDER_ID,
  CONTROL_PLANE_PROVIDER_LABEL,
  controlPlaneMcpUrl,
  renderWm2Chatmode,
} from './controlPlaneShared';

/** The subset of {@link ControlPlaneHost} the MCP registration depends on. */
export interface ControlPlanePortSource {
  readonly endpointPort: number | undefined;
  readonly onDidChangeEndpointPort: vscode.Event<number>;
}

// Minimal structural mirrors of the finalized 1.101 MCP API, so this compiles
// against the older pinned `@types/vscode`.
interface McpServerDefinitionProviderLike {
  onDidChangeMcpServerDefinitions?: vscode.Event<void>;
  provideMcpServerDefinitions: () => unknown[] | Thenable<unknown[]>;
  resolveMcpServerDefinition?: (server: unknown, token: vscode.CancellationToken) => unknown;
}
type RegisterMcpFn = (id: string, provider: McpServerDefinitionProviderLike) => vscode.Disposable;
type McpHttpServerDefinitionCtor = new (
  label: string,
  uri: vscode.Uri,
  headers?: Record<string, string>,
  version?: string,
) => unknown;

/**
 * Wire the control-plane into the extension. Safe to call unconditionally from
 * `activate()`; each half guards its own failures. `portSource` is the
 * {@link ControlPlaneHost}, which owns the authoritative endpoint port.
 */
export function initControlPlaneIntegration(
  context: vscode.ExtensionContext,
  portSource: ControlPlanePortSource,
  onControlPlaneReady?: () => void,
): void {
  try {
    maybeInstallWm2Agent(context);
  } catch (err) {
    console.error('[working-memory] wm2 chat mode install failed:', err);
  }

  try {
    registerControlPlaneMcpServer(context, portSource, onControlPlaneReady);
  } catch (err) {
    console.error('[working-memory] control-plane MCP registration failed:', err);
  }
}

/**
 * Register the control-plane MCP server definition provider, sourcing the
 * endpoint port from the host and re-firing the change event whenever the host
 * resolves/changes its owned port. The shared port file is NOT consulted here.
 */
function registerControlPlaneMcpServer(
  context: vscode.ExtensionContext,
  portSource: ControlPlanePortSource,
  onControlPlaneReady?: () => void,
): void {
  const lm = vscode.lm as unknown as {
    registerMcpServerDefinitionProvider?: RegisterMcpFn;
  };
  const register = lm.registerMcpServerDefinitionProvider;
  const HttpServerDefinition = (
    vscode as unknown as { McpHttpServerDefinition?: McpHttpServerDefinitionCtor }
  ).McpHttpServerDefinition;

  if (typeof register !== 'function' || typeof HttpServerDefinition !== 'function') {
    console.warn(
      '[working-memory] MCP server-definition API unavailable (needs VS Code >= 1.101); ' +
        'skipping control-plane registration.',
    );
    return;
  }

  const didChange = new vscode.EventEmitter<void>();
  context.subscriptions.push(didChange);

  let port: number | undefined = portSource.endpointPort;

  const provider: McpServerDefinitionProviderLike = {
    onDidChangeMcpServerDefinitions: didChange.event,
    provideMcpServerDefinitions: () => {
      if (port === undefined) {
        return [];
      }
      const uri = vscode.Uri.parse(controlPlaneMcpUrl(port));
      // VS Code caches an MCP server's tool manifest and only re-fetches
      // `tools/list` when the server definition's `version` changes. The owned
      // port already changes whenever a fresh embedded daemon binds (each
      // ephemeral spawn → new port), so keying the version on the port busts
      // the cache on a new daemon while staying stable for a long-lived
      // service on a fixed port.
      const version = `port-${port}`;
      return [new HttpServerDefinition(CONTROL_PLANE_PROVIDER_LABEL, uri, undefined, version)];
    },
  };

  context.subscriptions.push(register(CONTROL_PLANE_PROVIDER_ID, provider));

  let announcedReady = false;
  const applyPort = (resolved: number): void => {
    port = resolved;
    didChange.fire();
    if (!announcedReady) {
      announcedReady = true;
      // The control-plane-backed panel tabs (Active/Archive/Topics) rendered
      // their empty state during activation because the endpoint port was not
      // known yet. Now that it is, nudge the panel to re-fetch so it populates
      // without a manual refresh.
      onControlPlaneReady?.();
    }
    console.log(
      `[working-memory] control-plane MCP endpoint set to 127.0.0.1:${resolved}; server registered.`,
    );
  };

  // The port may already be known (service / auto-as-client resolve it
  // synchronously in the host's start()); otherwise wait for the host to
  // report the embedded child's bound port.
  if (port !== undefined) {
    applyPort(port);
  }
  context.subscriptions.push(portSource.onDidChangeEndpointPort(applyPort));
}

/**
 * Install the wm2 chat mode into the sandbox workspace. Gated to development
 * mode AND a workspace folder whose path ends with `wm-sandbox`, so it can
 * never write into Michael's real hub workspace.
 */
function maybeInstallWm2Agent(context: vscode.ExtensionContext): void {
  if (context.extensionMode !== vscode.ExtensionMode.Development) {
    return;
  }
  const folder = findSandboxFolder();
  if (!folder) {
    return;
  }
  const dir = path.join(folder, '.github', 'chatmodes');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wm2.chatmode.md');
  writeFileSync(file, renderWm2Chatmode(), 'utf8');
  console.log(`[working-memory] installed wm2 chat mode at ${file}`);
}

/** The open workspace folder whose path ends with `wm-sandbox`, if any. */
function findSandboxFolder(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const fsPath = folder.uri.fsPath.replace(/[\\/]+$/, '');
    if (fsPath.endsWith('wm-sandbox')) {
      return fsPath;
    }
  }
  return undefined;
}
