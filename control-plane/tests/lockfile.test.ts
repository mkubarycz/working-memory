import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acquireLock, AlreadyRunningError, isProcessAlive } from '../src/lockfile';

// A pid that is essentially guaranteed not to be alive on any host.
const DEAD_PID = 2 ** 31 - 1;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-cp-lock-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('isProcessAlive', () => {
  it('is true for the current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('is false for an absurd (dead) pid', () => {
    expect(isProcessAlive(DEAD_PID)).toBe(false);
  });

  it('is false for non-positive pids without signalling a process group', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });
});

describe('acquireLock', () => {
  it('creates a lockfile holding our pid and removes it on release', () => {
    const lp = path.join(dir, 'a.lock');
    const lock = acquireLock(lp);
    expect(lock.pid).toBe(process.pid);
    expect(fs.readFileSync(lp, 'utf8').trim()).toBe(String(process.pid));

    lock.release();
    expect(fs.existsSync(lp)).toBe(false);
  });

  it('creates the parent runtime directory if missing', () => {
    const lp = path.join(dir, 'nested', 'run', 'a.lock');
    const lock = acquireLock(lp);
    expect(fs.existsSync(lp)).toBe(true);
    lock.release();
  });

  it('refuses to start when a live rival holds the lock', () => {
    const lp = path.join(dir, 'a.lock');
    // Seed the lock with a known-alive pid (ourselves) as the "rival" holder,
    // then attempt to acquire as a different pid.
    fs.writeFileSync(lp, String(process.pid));
    expect(() => acquireLock(lp, process.pid + 1)).toThrow(AlreadyRunningError);
    // The rival's lockfile must be left intact.
    expect(fs.readFileSync(lp, 'utf8').trim()).toBe(String(process.pid));
  });

  it('reclaims a stale lock left by a dead process', () => {
    const lp = path.join(dir, 'a.lock');
    fs.writeFileSync(lp, String(DEAD_PID));
    const lock = acquireLock(lp);
    expect(fs.readFileSync(lp, 'utf8').trim()).toBe(String(process.pid));
    lock.release();
    expect(fs.existsSync(lp)).toBe(false);
  });

  it('reclaims a lock with unreadable/garbage contents', () => {
    const lp = path.join(dir, 'a.lock');
    fs.writeFileSync(lp, 'not-a-pid');
    const lock = acquireLock(lp);
    expect(lock.pid).toBe(process.pid);
    lock.release();
  });

  it('release is idempotent', () => {
    const lp = path.join(dir, 'a.lock');
    const lock = acquireLock(lp);
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });
});
