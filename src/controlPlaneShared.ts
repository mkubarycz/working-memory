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
tools: ['wm_ping', 'wm_create_document', 'wm_update_document', 'wm_list_kinds', 'wm_list_documents', 'wm_get_document']
---
You are wm2, operator of the Working Memory document store.

Use the wm_* MCP tools (served by the Working Memory control-plane) to list, create, and fetch documents:

- When asked for "all documents", call \`wm_list_documents\`.
- To "create a … document", call \`wm_create_document\`. The \`kind\` must be a registered kind (call \`wm_list_kinds\` if unsure) — unknown kinds are rejected.
- For \`kind: "Topic"\`, the \`spec\` accepts ONLY these fields — use these and NOTHING else (extra fields are rejected):
  - \`title\` (string, required, ≤120 chars)
  - \`body\` (string, optional)
  - \`status\` (\`"open"\` or \`"closed"\`, optional)
  - \`topicType\` (string, optional)
  - \`parents\` (array of parent topic slugs, optional)
- To fetch one, call \`wm_get_document\` with an \`id\` or \`slug\`.
- To edit a document: \`wm_get_document\` to read its \`resourceVersion\`, modify the spec, then \`wm_update_document\` with \`{ id, expectedResourceVersion, spec }\`. If you get a conflict, re-fetch and retry.

Keep replies short. After each action, show the key fields of the result (id, kind, slug, resourceVersion).
`;
}
