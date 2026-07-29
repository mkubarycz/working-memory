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
  /**
   * Whether the `WM_CONTROL_PLANE_HOME` env override may win. Only true in
   * Development (the F5 sandbox); in Production the env is ignored so a leaked
   * sandbox var can't repoint the installed extension. Omitted/undefined is
   * treated as allowed to preserve the pure resolvers' default behavior.
   */
  allowEnvOverride?: boolean;
}

/**
 * Resolve the control-plane app-data home directory, matching
 * `control-plane/src/paths.ts::resolveAppHome`:
 *  1. `WM_CONTROL_PLANE_HOME` (explicit override — only when `allowEnvOverride`)
 *  2. Windows → `%LOCALAPPDATA%\WorkingMemory`
 *  3. macOS   → `~/Library/Application Support/WorkingMemory`
 *  4. Linux   → `$XDG_DATA_HOME/working-memory` (or `~/.local/share/working-memory`)
 */
export function resolveControlPlaneHome(input: HomeEnv): string {
  const { platform, env, homedir, allowEnvOverride } = input;

  const override = env[CONTROL_PLANE_HOME_ENV];
  if (allowEnvOverride !== false && override && override.trim()) {
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
 *  1. `WM_CONTROL_PLANE_HOSTING` env override — only when `allowEnvOverride`
 *     (used by the F5 sandbox); ignored in Production.
 *  2. The `workingMemory.controlPlane.hosting` setting value.
 *  3. Default (`auto`).
 *
 * Values are trimmed + lower-cased; anything unrecognized is ignored so a typo
 * in one layer falls through to the next rather than breaking hosting.
 */
export function resolveHostingMode(input: {
  envValue?: string | null;
  settingValue?: string | null;
  allowEnvOverride?: boolean;
}): ControlPlaneHostingMode {
  const env = (input.envValue ?? '').trim().toLowerCase();
  if (input.allowEnvOverride !== false && isHostingMode(env)) {
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
 *  1. `WM_CONTROL_PLANE_HOME` env override — only when the passed `homeEnv`
 *     sets `allowEnvOverride` (F5 sandbox + tests); ignored in Production.
 *  2. The `workingMemory.controlPlane.storePath` setting, when non-empty.
 *  3. The per-OS app-data default (`resolveControlPlaneHome`).
 *
 * This maps the store-path setting onto `WM_CONTROL_PLANE_HOME` — the same var
 * the daemon reads — while keeping the env override authoritative in Dev.
 */
export function resolveControlPlaneStoreHome(input: {
  homeEnv: HomeEnv;
  settingPath?: string | null;
}): string {
  const override = input.homeEnv.env[CONTROL_PLANE_HOME_ENV];
  if (input.homeEnv.allowEnvOverride !== false && override && override.trim()) {
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

/** Loopback `/mcp` endpoint URL for a control-plane bound to `port`. */
export function controlPlaneMcpUrl(port: number): string {
  return `http://127.0.0.1:${port}/mcp`;
}

/**
 * Env var: pins the control-plane TCP port. Read by the daemon (bind port) and,
 * in Development only, by the extension host to steer service/auto-client
 * endpoint resolution. Ignored by the extension in Production (mirrors the
 * `WM_CONTROL_PLANE_HOME` env-gating) so a leaked sandbox var can't repoint the
 * installed extension.
 */
export const CONTROL_PLANE_PORT_ENV = 'WM_CONTROL_PLANE_PORT';

/**
 * Well-known default port for an EXTERNAL/standalone control-plane daemon
 * (service mode, or auto-mode probing for a running service). The embedded
 * self-hosted daemon does NOT use this — the host spawns it on an ephemeral
 * port and learns the actual bound port from the daemon's stdout, so two hosts
 * never race for a fixed port.
 */
export const DEFAULT_CONTROL_PLANE_SERVICE_PORT = 7717;

/**
 * Marker the daemon prints to stdout once its HTTP server is bound:
 * `WM_CONTROL_PLANE_LISTENING <port>`. The embedded host parses this from the
 * child's own stdout stream to learn the ACTUAL bound port — no port-file race,
 * no TOCTOU, and inherently tied to our own child process.
 */
export const CONTROL_PLANE_LISTENING_MARKER = 'WM_CONTROL_PLANE_LISTENING';

/**
 * Coerce a port-ish value (number, or a numeric string from an env var) into a
 * valid TCP port number, or `null` when it is absent/invalid. `0` is rejected
 * here on purpose: it is a valid *bind request* (ephemeral) but never a valid
 * endpoint to connect to.
 */
export function coercePort(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    n = Number.parseInt(trimmed, 10);
  } else {
    return null;
  }
  return isValidPort(n) ? n : null;
}

/**
 * Parse the daemon's `WM_CONTROL_PLANE_LISTENING <port>` line out of a stdout
 * chunk/buffer. Tolerant of surrounding log noise and chunk concatenation:
 * scans for the marker anywhere in the text. Returns the port, or `null` when
 * the marker is absent or the port is out of range.
 */
export function parseListeningPort(text: string): number | null {
  const re = new RegExp(`${CONTROL_PLANE_LISTENING_MARKER}\\s+(\\d{1,5})\\b`);
  const match = re.exec(text);
  if (!match) {
    return null;
  }
  return coercePort(match[1]);
}

/**
 * Resolve the port to CONNECT to for a control-plane we do NOT own — i.e.
 * `service` mode (external OS service) and `auto` mode's health probe for a
 * running service. Precedence:
 *  1. `WM_CONTROL_PLANE_PORT` env override — only when `allowEnvOverride`
 *     (Development / F5 sandbox); ignored in Production.
 *  2. The `workingMemory.controlPlane.port` setting, when a valid port.
 *  3. The well-known default ({@link DEFAULT_CONTROL_PLANE_SERVICE_PORT}).
 *
 * Never returns 0: unlike an embedded *bind* request, a client endpoint must be
 * a concrete port, so an invalid/zero value at any layer falls through.
 */
export function resolveServicePort(input: {
  envValue?: string | number | null;
  settingValue?: string | number | null;
  allowEnvOverride?: boolean;
}): number {
  if (input.allowEnvOverride !== false) {
    const env = coercePort(input.envValue);
    if (env !== null) {
      return env;
    }
  }
  const setting = coercePort(input.settingValue);
  if (setting !== null) {
    return setting;
  }
  return DEFAULT_CONTROL_PLANE_SERVICE_PORT;
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

/** A single-process signaller — `process.kill`-shaped, but injectable for tests. */
export type PidKiller = (pid: number, signal: NodeJS.Signals | 0) => void;

/**
 * Terminate exactly one daemon `pid`: SIGTERM, wait `graceMs`, then SIGKILL if
 * it's still alive. Every signal is guarded — an `ESRCH` (process already gone)
 * is a success, not an error — so this never throws. Purposely pid-scoped: it
 * only touches the process whose id we were handed (read from the sandbox port
 * file), never a shared entry-path match, so it can't disturb an unrelated
 * (e.g. installed/production) daemon.
 *
 * Injectable `kill`/`delay` keep it unit-testable without spawning processes.
 */
export async function terminateDaemonPid(
  pid: number,
  kill: PidKiller,
  delay: (ms: number) => Promise<void>,
  graceMs = 750,
): Promise<void> {
  try {
    kill(pid, 'SIGTERM');
  } catch {
    // ESRCH (already gone) or EPERM — nothing more we can safely do.
    return;
  }
  await delay(graceMs);
  // Signal 0 probes liveness: throws ESRCH once the process has exited.
  let alive = true;
  try {
    kill(pid, 0);
  } catch {
    alive = false;
  }
  if (alive) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      /* raced us to exit — fine */
    }
  }
}

/**
 * The wm2 chat mode installed into the sandbox. `tools` lists the bare
 * control-plane MCP tool names — the same identifier form VS Code documents for
 * tool sets referencing MCP-server tools.
 */
export function renderWm2Chatmode(): string {
  return `---
description: 'wm2 — operator of the Working Memory document store (control-plane MCP).'
tools: ['wm-ping', 'wm-document-create', 'wm-document-read', 'wm-document-update', 'wm-document-delete', 'wm-list-kinds', 'ws-workstream-create', 'ws-workstream-read', 'ws-workstream-update', 'ws-workstream-delete', 'ws-topic-create', 'ws-topic-read', 'ws-topic-update', 'ws-topic-delete', 'ws-topictype-create', 'ws-topictype-read', 'ws-topictype-update', 'ws-topictype-delete', 'ws-alert-create', 'ws-alert-read', 'ws-alert-update', 'ws-alert-delete']
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
  - \`workstreams\` (array of member workstream slugs, optional)
- To edit a document: \`wm-document-read\` (by \`id\`) to read its \`resourceVersion\`, then \`wm-document-update\` with \`{ id, expectedResourceVersion }\` plus ONLY the fields you're changing — \`spec\` is a partial (merged onto the current doc), and \`slug\`/\`labels\` replace if provided. To clear a field send it explicitly (e.g. \`parents: []\`). If you get a conflict, re-fetch and retry.
- To delete a document: \`wm-document-delete\` with its \`id\` (works on any document). To undelete: \`wm-document-delete\` with \`restore: true\`.
- Workstreams have a dedicated API that speaks the workstream shape directly (no \`kind\` needed): \`ws-workstream-create\` ({ title, slug?, status?, closure? }), \`ws-workstream-read\` (by \`slug\`/\`id\`, or list all with optional \`query\`/\`limit\`), \`ws-workstream-update\` ({ slug, …changed fields }), and \`ws-workstream-delete\` ({ slug, restore? }). Prefer these for workstreams.
- Topics likewise have a dedicated API that speaks the topic shape directly: \`ws-topic-create\` ({ title, slug?, body?, status?, topicType?, parents?, workstreams? }), \`ws-topic-read\` (by \`slug\`/\`id\`, or list all with optional \`query\`/\`workstream\`/\`limit\` — \`workstream\` filters to topics whose membership includes that slug), \`ws-topic-update\` ({ slug, …changed fields }), and \`ws-topic-delete\` ({ slug, restore? }). Edit workstream membership via \`ws-topic-update\` on \`workstreams\`. Prefer these for topics.
- TopicTypes (topic subtypes like 'feature' / 'task') have a dedicated API that speaks the topic-type shape directly (they carry a registry-key \`slug\`): \`ws-topictype-create\` ({ label, icon, description, slug?, body_template? }), \`ws-topictype-read\` (by \`slug\`/\`id\`, or list all with optional \`query\`/\`limit\`), \`ws-topictype-update\` ({ slug, …changed fields }), and \`ws-topictype-delete\` ({ slug, restore? }).
- Alerts (structured "needs attention" items) have a dedicated API — Alerts have NO slug, so they key on the document \`id\`: \`ws-alert-create\` ({ description, title?, recommended_action?, status?, dedupe_key?, created_by? }), \`ws-alert-read\` (by \`id\`, or list all with optional \`query\`/\`limit\`), \`ws-alert-update\` ({ id, …changed fields }), and \`ws-alert-delete\` ({ id, restore? }).

Keep replies short. After each action, show the key fields of the result (id, kind, slug, resourceVersion).
`;
}
