/**
 * OS-appropriate app-data path resolution for the control-plane service.
 *
 * Resolves the durable **store dir** (where the SQLite database lives) and the
 * ephemeral **runtime dir** (where the lockfile + port file live) per-OS,
 * rather than hard-coding POSIX paths. An explicit `WM_CONTROL_PLANE_HOME`
 * override short-circuits platform resolution — used by the F5 sandbox and by
 * the unit tests so they never touch the real user profile.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { DB_FILE, HOME_ENV, LOCK_FILE, PORT_FILE } from './config.js';

export interface PathEnv {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  homedir: string;
}

/** App-data directory name — PascalCase on macOS/Windows, kebab on Linux (XDG). */
const APP_DIR_NAME_DEFAULT = 'WorkingMemory';
const APP_DIR_NAME_XDG = 'working-memory';

function defaultPathEnv(): PathEnv {
  return { platform: process.platform, env: process.env, homedir: os.homedir() };
}

function resolve(input: Partial<PathEnv>): PathEnv {
  return { ...defaultPathEnv(), ...input };
}

/**
 * Resolve the control-plane's app-data home directory.
 *
 * Order of precedence:
 *  1. `WM_CONTROL_PLANE_HOME` (explicit override)
 *  2. Windows → `%LOCALAPPDATA%\WorkingMemory`
 *  3. macOS   → `~/Library/Application Support/WorkingMemory`
 *  4. Linux   → `$XDG_DATA_HOME/working-memory` (or `~/.local/share/working-memory`)
 */
export function resolveAppHome(input: Partial<PathEnv> = {}): string {
  const { platform, env, homedir } = resolve(input);

  const override = env[HOME_ENV];
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

  // Linux + other POSIX platforms.
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg || path.join(homedir, '.local', 'share');
  return path.join(base, APP_DIR_NAME_XDG);
}

/** Durable content dir — currently the app home itself. */
export function storeDir(input: Partial<PathEnv> = {}): string {
  return resolveAppHome(input);
}

/** Ephemeral runtime dir for the lock + port file (`<home>/run`). */
export function runtimeDir(input: Partial<PathEnv> = {}): string {
  return path.join(resolveAppHome(input), 'run');
}

/** Absolute path to the SQLite database file. */
export function dbPath(input: Partial<PathEnv> = {}): string {
  return path.join(storeDir(input), DB_FILE);
}

/** Absolute path to the single-instance lockfile. */
export function lockPath(input: Partial<PathEnv> = {}): string {
  return path.join(runtimeDir(input), LOCK_FILE);
}

/** Absolute path to the discovery port file. */
export function portFilePath(input: Partial<PathEnv> = {}): string {
  return path.join(runtimeDir(input), PORT_FILE);
}
