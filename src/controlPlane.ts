/**
 * Control-plane integration (WM 13.0 "f5-wiring").
 *
 * Three responsibilities, all best-effort and non-fatal to activation:
 *  1. Discover the standalone control-plane daemon via its port file and
 *     register its localhost Streamable-HTTP endpoint as an MCP server so
 *     Copilot chat picks up the `wm_*` document tools.
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
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  CONTROL_PLANE_PROVIDER_ID,
  CONTROL_PLANE_PROVIDER_LABEL,
  controlPlanePortFilePath,
  parsePortInfo,
  renderWm2Chatmode,
  resolveControlPlaneHome,
  type PortInfo,
} from './controlPlaneShared';

/** How long to wait for the port file to appear (the daemon starts concurrently). */
const DISCOVERY_TIMEOUT_MS = 10_000;
/** Poll interval while waiting for the port file. */
const DISCOVERY_INTERVAL_MS = 500;

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
 * `activate()`; each half guards its own failures.
 */
export function initControlPlaneIntegration(
  context: vscode.ExtensionContext,
  onControlPlaneReady?: () => void,
): void {
  try {
    maybeInstallWm2Agent(context);
  } catch (err) {
    console.error('[working-memory] wm2 chat mode install failed:', err);
  }

  try {
    registerControlPlaneMcpServer(context, onControlPlaneReady);
  } catch (err) {
    console.error('[working-memory] control-plane MCP registration failed:', err);
  }
}

/**
 * Register the control-plane MCP server definition provider, then poll for the
 * daemon's port file and fire the change event so VS Code (re)queries once the
 * endpoint is known.
 */
function registerControlPlaneMcpServer(
  context: vscode.ExtensionContext,
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

  let discovered: PortInfo | null = null;

  const provider: McpServerDefinitionProviderLike = {
    onDidChangeMcpServerDefinitions: didChange.event,
    provideMcpServerDefinitions: () => {
      if (!discovered) {
        return [];
      }
      const uri = vscode.Uri.parse(`http://127.0.0.1:${discovered.port}/mcp`);
      // VS Code caches an MCP server's tool manifest and only re-fetches
      // `tools/list` when the server definition's `version` changes. Derive the
      // version from the discovered daemon's port + pid so a fresh daemon (new
      // build → new pid) always busts the cache and VS Code re-indexes the
      // tools. A long-lived production daemon keeps a stable pid, so it won't
      // needlessly re-index.
      const version = `${discovered.port}-${discovered.pid}`;
      return [new HttpServerDefinition(CONTROL_PLANE_PROVIDER_LABEL, uri, undefined, version)];
    },
  };

  context.subscriptions.push(register(CONTROL_PLANE_PROVIDER_ID, provider));

  const home = resolveControlPlaneHome({
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
  });
  const portFile = controlPlanePortFilePath(home);

  void discoverPortInfo(portFile).then((info) => {
    if (info) {
      discovered = info;
      didChange.fire();
      // The control-plane-backed panel tabs (Active/Archive/Topics) rendered
      // their empty state during activation because the daemon's port file did
      // not exist yet. Now that the daemon is ready, nudge the panel to
      // re-fetch so it populates without a manual refresh.
      onControlPlaneReady?.();
      console.log(
        `[working-memory] control-plane discovered on 127.0.0.1:${info.port} ` +
          `(pid ${info.pid}); MCP server registered.`,
      );
    } else {
      console.warn(
        `[working-memory] control-plane port file not found at ${portFile} within ` +
          `${DISCOVERY_TIMEOUT_MS / 1000}s; MCP server not registered.`,
      );
    }
  });
}

/** Read + parse the port file once; `null` when missing or malformed. */
function readPortInfo(portFile: string): PortInfo | null {
  let raw: string;
  try {
    raw = readFileSync(portFile, 'utf8');
  } catch {
    return null;
  }
  return parsePortInfo(raw);
}

/** Poll the port file until it appears or the timeout elapses. */
async function discoverPortInfo(
  portFile: string,
  timeoutMs: number = DISCOVERY_TIMEOUT_MS,
  intervalMs: number = DISCOVERY_INTERVAL_MS,
): Promise<PortInfo | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = readPortInfo(portFile);
    if (info) {
      return info;
    }
    if (Date.now() >= deadline) {
      return null;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
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
