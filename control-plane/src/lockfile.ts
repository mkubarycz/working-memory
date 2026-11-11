/**
 * Single-instance guard for the control-plane daemon.
 *
 * Half of the guard: an exclusively-created lockfile holding the owner's pid.
 * A second launch reads the pid and probes liveness — if the holder is alive
 * it refuses to start a rival writer; if the holder is dead (stale lock from a
 * crash) it reclaims the lock. The other half — the discovery port file — is
 * in portfile.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LOCK_FILE } from './config.js';

export class AlreadyRunningError extends Error {
  constructor(
    public readonly holderPid: number,
    public readonly lockPath: string,
  ) {
    super(
      `another control-plane instance is already running ` +
        `(pid ${holderPid}, lock ${lockPath})`,
    );
    this.name = 'AlreadyRunningError';
  }
}

export interface Lock {
  readonly path: string;
  readonly pid: number;
  release(): void;
}

const OFFLINE_MAINTENANCE_FILE = 'offline-maintenance.lock';

function pathExists(filename: string): boolean {
  try {
    fs.lstatSync(filename);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function assertNoOfflineMaintenance(runtimeDirectory: string): void {
  if (pathExists(path.join(runtimeDirectory, OFFLINE_MAINTENANCE_FILE))) {
    throw new Error('An offline database maintenance operation is active; the control plane will not open the database.');
  }
}

/**
 * Prevent the daemon from opening a database while an explicit offline tool
 * owns it. The caller must pass the database path.
 */
export function acquireOfflineMaintenanceLock(databasePath: string): Lock {
  const runtimeDirectory = path.join(path.dirname(path.resolve(databasePath)), 'run');
  const serviceLockPath = path.join(runtimeDirectory, LOCK_FILE);
  const maintenanceLockPath = path.join(runtimeDirectory, OFFLINE_MAINTENANCE_FILE);
  fs.mkdirSync(runtimeDirectory, { recursive: true });

  if (pathExists(serviceLockPath)) {
    throw new Error('The control plane is running. Stop it before opening the database for offline maintenance.');
  }

  const token = randomUUID();
  let fd: number;
  try {
    fd = fs.openSync(maintenanceLockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('Another offline database maintenance operation is active.');
    }
    throw error;
  }
  try {
    fs.writeFileSync(fd, token);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(maintenanceLockPath, { force: true });
    throw error;
  }
  fs.closeSync(fd);

  if (pathExists(serviceLockPath)) {
    fs.rmSync(maintenanceLockPath, { force: true });
    throw new Error('The control plane started while offline maintenance was being prepared; no database was opened.');
  }

  let released = false;
  return {
    path: maintenanceLockPath,
    pid: process.pid,
    release(): void {
      if (released) return;
      released = true;
      try {
        if (fs.readFileSync(maintenanceLockPath, 'utf8') === token) {
          fs.rmSync(maintenanceLockPath, { force: true });
        }
      } catch {
        /* ignore */
      }
    },
  };
}

/** True if a process with the given pid is currently alive. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    // Signal 0 performs error checking without actually sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM → the process exists but we lack permission to signal it → alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockPid(lockPath: string): number | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function tryCreateLock(lockPath: string, pid: number): boolean {
  try {
    // 'wx' → create exclusively; fails with EEXIST if the file already exists.
    const fd = fs.openSync(lockPath, 'wx');
    try {
      fs.writeFileSync(fd, String(pid));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return false;
    }
    throw err;
  }
}

function makeLock(lockPath: string, pid: number): Lock {
  let released = false;
  return {
    path: lockPath,
    pid,
    release(): void {
      if (released) {
        return;
      }
      released = true;
      // Only remove the file if it still belongs to us.
      const holder = readLockPid(lockPath);
      if (holder === null || holder === pid) {
        fs.rmSync(lockPath, { force: true });
      }
    },
  };
}

/**
 * Acquire the single-instance lock, writing `pid` into an exclusively-created
 * lockfile.
 *
 *  - Free / non-existent → create it and return the lock.
 *  - Held by a **live** process (other than `pid`) → throw AlreadyRunningError.
 *  - Held by a **dead** process (stale) or unreadable → reclaim and return.
 */
export function acquireLock(lockPath: string, pid: number = process.pid): Lock {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  if (tryCreateLock(lockPath, pid)) {
    return makeLock(lockPath, pid);
  }

  // Lockfile already exists — inspect the current holder.
  const holder = readLockPid(lockPath);
  if (holder !== null && holder !== pid && isProcessAlive(holder)) {
    throw new AlreadyRunningError(holder, lockPath);
  }

  // Stale (dead holder / unreadable / our own pid) — reclaim it.
  fs.rmSync(lockPath, { force: true });
  if (tryCreateLock(lockPath, pid)) {
    return makeLock(lockPath, pid);
  }

  // Lost a race with another starter between the rm and the re-create.
  const other = readLockPid(lockPath);
  if (other !== null && other !== pid && isProcessAlive(other)) {
    throw new AlreadyRunningError(other, lockPath);
  }
  throw new Error(`failed to acquire lock at ${lockPath}`);
}
