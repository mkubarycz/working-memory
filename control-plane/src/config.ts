/**
 * Static configuration + well-known constants for the Working Memory
 * control-plane service (Phase 1 skeleton). No I/O here — just values shared
 * across the daemon, server, paths, and launcher modules.
 */

/** MCP server identity name (sent in the `initialize` handshake). */
export const SERVICE_NAME = 'working-memory-control-plane';

/**
 * Semantic version of the control-plane service. Deliberately independent of
 * the VS Code extension's version in the repo-root package.json — this is a
 * brand-new standalone app starting at 0.1.0. Reported by `wm_ping` and
 * `GET /health`.
 */
export const SERVICE_VERSION = '0.1.0';

/** Loopback host — the service binds here and nowhere else. */
export const HOST = '127.0.0.1';

/** Default TCP port; override with the WM_CONTROL_PLANE_PORT env var. */
export const DEFAULT_PORT = 7717;

/** Streamable-HTTP MCP endpoint path. */
export const MCP_PATH = '/mcp';

/** Health-probe path. */
export const HEALTH_PATH = '/health';

/** launchd LaunchAgent label (reverse-DNS); also the plist filename stem. */
export const LAUNCHD_LABEL = 'com.kubarycz.working-memory.control-plane';

/** Env var: overrides the resolved app-data home (tests + the F5 sandbox). */
export const HOME_ENV = 'WM_CONTROL_PLANE_HOME';

/** Env var: overrides the default port. */
export const PORT_ENV = 'WM_CONTROL_PLANE_PORT';

/** Runtime-dir filename for the single-instance lock. */
export const LOCK_FILE = 'control-plane.lock';

/** Runtime-dir filename for the discovery port file (`{ port, pid }`). */
export const PORT_FILE = 'control-plane.port.json';

/** Store-dir filename for the SQLite database. */
export const DB_FILE = 'journal.sqlite';
