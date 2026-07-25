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
