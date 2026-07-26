/**
 * Pure, VS Code-free helpers for the control-plane integration.
 *
 * Kept separate from `controlPlane.ts` (which imports `vscode`) so the home
 * resolution, port-file parsing, and the wm2 chatmode text can be unit-tested
 * under vitest without stubbing the editor API. This mirrors the resolution
 * logic in `control-plane/src/paths.ts` + `portfile.ts` — duplicated here on
 * purpose because the extension build (`tsc -p .`) and the control-plane build
 * (`tsc -p control-plane`) are separate programs with different module output.
 */

import * as path from 'node:path';

/** Env var: overrides the resolved control-plane app-data home. */
export const CONTROL_PLANE_HOME_ENV = 'WM_CONTROL_PLANE_HOME';

/**
 * Env var: overrides the `workingMemory.controlPlane.hosting` setting. Used by
 * the F5 sandbox launch config so the ext host self-hosts the daemon without
 * touching Michael's user settings.
 */
export const CONTROL_PLANE_HOSTING_ENV = 'WM_CONTROL_PLANE_HOSTING';

/** Runtime-dir filename for the discovery port file (`{ port, pid }`). */
export const CONTROL_PLANE_PORT_FILE = 'control-plane.port.json';

/** MCP server definition provider id — must match `package.json`. */
export const CONTROL_PLANE_PROVIDER_ID = 'workingMemoryControlPlane';

/** Human-readable label for the contributed MCP server. */
export const CONTROL_PLANE_PROVIDER_LABEL = 'Working Memory Control Plane';

const APP_DIR_NAME_DEFAULT = 'WorkingMemory';
const APP_DIR_NAME_XDG = 'working-memory';

export interface PortInfo {
  port: number;
  pid: number;
}

export interface HomeEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
}

/**
 * Resolve the control-plane app-data home directory, matching
 * `control-plane/src/paths.ts::resolveAppHome`:
 *  1. `WM_CONTROL_PLANE_HOME` (explicit override)
 *  2. Windows → `%LOCALAPPDATA%\WorkingMemory`
 *  3. macOS   → `~/Library/Application Support/WorkingMemory`
 *  4. Linux   → `$XDG_DATA_HOME/working-memory` (or `~/.local/share/working-memory`)
 */
export function resolveControlPlaneHome(input: HomeEnv): string {
  const { platform, env, homedir } = input;

  const override = env[CONTROL_PLANE_HOME_ENV];
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }

  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || path.join(homedir, 'AppData', 'Local');
    return path.join(base, APP_DIR_NAME_DEFAULT);
  }

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', APP_DIR_NAME_DEFAULT);
  }

  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg || path.join(homedir, '.local', 'share');
  return path.join(base, APP_DIR_NAME_XDG);
}

/** Absolute path to the discovery port file for a given home dir. */
export function controlPlanePortFilePath(home: string): string {
  return path.join(home, 'run', CONTROL_PLANE_PORT_FILE);
}

/**
 * Who runs the control-plane process:
 *  - `auto`     — use a running service if one is reachable, else self-host.
 *  - `embedded` — the extension spawns + supervises the process itself.
 *  - `service`  — an external OS service owns it; the extension is a pure client.
 */
export type ControlPlaneHostingMode = 'auto' | 'embedded' | 'service';

/** The default hosting mode when neither env nor setting resolves to a valid value. */
export const DEFAULT_CONTROL_PLANE_HOSTING: ControlPlaneHostingMode = 'auto';

function isHostingMode(value: string): value is ControlPlaneHostingMode {
  return value === 'auto' || value === 'embedded' || value === 'service';
}

/**
 * Resolve the effective hosting mode. Precedence:
 *  1. `WM_CONTROL_PLANE_HOSTING` env override (used by the F5 sandbox).
 *  2. The `workingMemory.controlPlane.hosting` setting value.
 *  3. Default (`auto`).
 *
 * Values are trimmed + lower-cased; anything unrecognized is ignored so a typo
 * in one layer falls through to the next rather than breaking hosting.
 */
export function resolveHostingMode(input: {
  envValue?: string | null;
  settingValue?: string | null;
}): ControlPlaneHostingMode {
  const env = (input.envValue ?? '').trim().toLowerCase();
  if (isHostingMode(env)) {
    return env;
  }
  const setting = (input.settingValue ?? '').trim().toLowerCase();
  if (isHostingMode(setting)) {
    return setting;
  }
  return DEFAULT_CONTROL_PLANE_HOSTING;
}

/**
 * Resolve the control-plane store home directory. Precedence:
 *  1. `WM_CONTROL_PLANE_HOME` env override (F5 sandbox + tests).
 *  2. The `workingMemory.controlPlane.storePath` setting, when non-empty.
 *  3. The per-OS app-data default (`resolveControlPlaneHome`).
 *
 * This maps the store-path setting onto `WM_CONTROL_PLANE_HOME` — the same var
 * the daemon reads — while keeping the env override authoritative.
 */
export function resolveControlPlaneStoreHome(input: {
  homeEnv: HomeEnv;
  settingPath?: string | null;
}): string {
  const override = input.homeEnv.env[CONTROL_PLANE_HOME_ENV];
  if (override && override.trim()) {
    return path.resolve(override.trim());
  }
  const setting = (input.settingPath ?? '').trim();
  if (setting) {
    return path.resolve(setting);
  }
  return resolveControlPlaneHome(input.homeEnv);
}

/** Loopback health-probe URL for a control-plane bound to `port`. */
export function controlPlaneHealthUrl(port: number): string {
  return `http://127.0.0.1:${port}/health`;
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port <= 65535;
}

function isValidPid(pid: unknown): pid is number {
  return typeof pid === 'number' && Number.isInteger(pid) && pid > 0;
}

/**
 * Parse + validate the raw port-file JSON. Returns `null` when the content is
 * missing, malformed, or fails validation (never throws) so callers can treat
 * "not ready yet" and "garbage" identically during the discovery poll.
 */
export function parsePortInfo(raw: string | null | undefined): PortInfo | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const { port, pid } = parsed as Record<string, unknown>;
  if (!isValidPort(port) || !isValidPid(pid)) {
    return null;
  }
  return { port, pid };
}

/**
 * The wm2 chat mode installed into the sandbox. `tools` lists the bare
 * control-plane MCP tool names — the same identifier form VS Code documents for
 * tool sets referencing MCP-server tools.
 */
export function renderWm2Chatmode(): string {
  return `---
description: 'wm2 — operator of the Working Memory document store (control-plane MCP).'
tools: ['wm-ping', 'wm-document-create', 'wm-document-read', 'wm-document-update', 'wm-document-delete', 'wm-list-kinds']
---
You are wm2, operator of the Working Memory document store.

Use the wm_* MCP tools (served by the Working Memory control-plane) to read, create, update, and delete documents:

- To read documents, call \`wm-document-read\`. It handles BOTH get and list: pass an \`id\` or \`slug\` to read ONE, or omit them to LIST — \`kind\` filters by kind and \`query\` does a basic case-insensitive substring search over the document text. It ALWAYS returns \`{ count, documents }\` (a single read is a 0-or-1 element list).
- To "create a … document", call \`wm-document-create\`. The \`kind\` must be a registered kind (call \`wm-list-kinds\` if unsure) — unknown kinds are rejected.
- For \`kind: "Topic"\`, the \`spec\` accepts ONLY these fields — use these and NOTHING else (extra fields are rejected):
  - \`title\` (string, required, ≤120 chars)
  - \`body\` (string, optional)
  - \`status\` (\`"open"\` or \`"closed"\`, optional)
  - \`topicType\` (string, optional)
  - \`parents\` (array of parent topic slugs, optional)
- To edit a document: \`wm-document-read\` (by \`id\`) to read its \`resourceVersion\`, then \`wm-document-update\` with \`{ id, expectedResourceVersion }\` plus ONLY the fields you're changing — \`spec\` is a partial (merged onto the current doc), and \`slug\`/\`labels\` replace if provided. To clear a field send it explicitly (e.g. \`parents: []\`). If you get a conflict, re-fetch and retry.
- To delete a document: \`wm-document-delete\` with its \`id\` (works on any document). To undelete: \`wm-document-delete\` with \`restore: true\`.

Keep replies short. After each action, show the key fields of the result (id, kind, slug, resourceVersion).
`;
}
