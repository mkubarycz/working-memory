/**
 * Daemon orchestration: acquire the single-instance lock, open the store, bind
 * the server, publish the discovery port file, and wire graceful shutdown.
 *
 * This ties the skeleton's pieces together but stays deliberately thin — the
 * resource layer, migration/cutover, and the real `wm_*` surface are later
 * phases.
 */

import * as fs from 'node:fs';
import {
  dbPath,
  lockPath,
  portFilePath,
  resolveAppHome,
  runtimeDir,
  storeDir,
} from './paths.js';
import { acquireLock, type Lock } from './lockfile.js';
import { removePortFile, writePortFile } from './portfile.js';
import { openStore, type Store } from './store.js';
import { startServer, type RunningServer } from './server.js';
import { loadKinds } from './kinds/loader.js';
import { DEFAULT_PORT, HOST, PORT_ENV, SERVICE_VERSION } from './config.js';

export interface Daemon {
  readonly port: number;
  readonly home: string;
  stop(): Promise<void>;
}

function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(`[control-plane] ${msg}`);
}

function resolvePreferredPort(): number {
  const raw = process.env[PORT_ENV];
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) {
      return n;
    }
  }
  return DEFAULT_PORT;
}

async function startWithFallback(preferred: number, store: Store): Promise<RunningServer> {
  try {
    return await startServer({ host: HOST, port: preferred, version: SERVICE_VERSION, store });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE' && preferred !== 0) {
      log(`port ${preferred} in use — falling back to an ephemeral port`);
      return startServer({ host: HOST, port: 0, version: SERVICE_VERSION, store });
    }
    throw err;
  }
}

function installSignalHandlers(stop: () => Promise<void>): void {
  let stopping = false;
  const handler = (sig: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    log(`received ${sig} — shutting down`);
    stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}

/**
 * Boot the daemon. Rejects with `AlreadyRunningError` if a live instance holds
 * the lock. On success, resolves with a handle whose `stop()` tears everything
 * down (also wired to SIGINT/SIGTERM).
 */
export async function runDaemon(): Promise<Daemon> {
  const home = resolveAppHome();
  fs.mkdirSync(storeDir(), { recursive: true });
  fs.mkdirSync(runtimeDir(), { recursive: true });

  const lock: Lock = acquireLock(lockPath());

  let store: Store | undefined;
  let server: RunningServer | undefined;

  try {
    store = openStore(dbPath());
    const kinds = await loadKinds();
    log(`registered kinds: ${kinds.length ? kinds.join(', ') : '(none)'}`);
    server = await startWithFallback(resolvePreferredPort(), store);
    writePortFile(portFilePath(), { port: server.port, pid: process.pid });

    const boundServer = server;
    const openedStore = store;
    const stop = async (): Promise<void> => {
      try {
        removePortFile(portFilePath());
      } catch {
        /* ignore */
      }
      try {
        await boundServer.close();
      } catch {
        /* ignore */
      }
      try {
        openedStore.close();
      } catch {
        /* ignore */
      }
      lock.release();
    };

    installSignalHandlers(stop);

    log(`listening on ${server.url}  (pid ${process.pid})`);
    log(`home:      ${home}`);
    log(`store:     ${dbPath()}`);
    log(`port file: ${portFilePath()}`);

    return { port: server.port, home, stop };
  } catch (err) {
    if (server) {
      try {
        await server.close();
      } catch {
        /* ignore */
      }
    }
    if (store) {
      try {
        store.close();
      } catch {
        /* ignore */
      }
    }
    lock.release();
    throw err;
  }
}
