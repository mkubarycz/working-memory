/**
 * Unit tests for `terminateDaemonPid` — the pid-scoped daemon killer that
 * replaced the entry-path `pkill -f` in `freeStalePort()` (bug:
 * f5-killstale-kills-prod-daemon). It must target ONLY the pid it's handed
 * (read from the sandbox port file), SIGTERM → grace → SIGKILL-if-alive, and
 * never throw when the process is already gone.
 */

import { describe, it, expect, vi } from 'vitest';
import { terminateDaemonPid, type PidKiller } from '../src/controlPlaneShared';

/** A no-wait delay so tests don't actually sleep through the grace period. */
const noDelay = () => Promise.resolve();

describe('terminateDaemonPid', () => {
  it('SIGTERMs the pid, then SIGKILLs when it is still alive after the grace', async () => {
    const calls: Array<[number, NodeJS.Signals | 0]> = [];
    const kill: PidKiller = (pid, signal) => {
      calls.push([pid, signal]);
      // signal 0 (liveness probe) succeeds → process still alive.
    };

    await terminateDaemonPid(1234, kill, noDelay);

    expect(calls).toEqual([
      [1234, 'SIGTERM'],
      [1234, 0],
      [1234, 'SIGKILL'],
    ]);
  });

  it('does NOT SIGKILL when the process has already exited after SIGTERM', async () => {
    const calls: Array<[number, NodeJS.Signals | 0]> = [];
    const kill: PidKiller = (pid, signal) => {
      calls.push([pid, signal]);
      if (signal === 0) {
        // Liveness probe: process is gone → ESRCH.
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
    };

    await terminateDaemonPid(1234, kill, noDelay);

    expect(calls).toEqual([
      [1234, 'SIGTERM'],
      [1234, 0],
    ]);
    expect(calls.some(([, s]) => s === 'SIGKILL')).toBe(false);
  });

  it('returns quietly when the pid is already gone at SIGTERM time (ESRCH)', async () => {
    const kill: PidKiller = () => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    };

    await expect(terminateDaemonPid(999, kill, noDelay)).resolves.toBeUndefined();
  });

  it('waits the grace period between SIGTERM and the liveness probe', async () => {
    const order: string[] = [];
    const kill: PidKiller = (_pid, signal) => {
      order.push(String(signal));
    };
    const delay = vi.fn(async (_ms: number) => {
      order.push('delay');
    });

    await terminateDaemonPid(42, kill, delay, 750);

    expect(delay).toHaveBeenCalledWith(750);
    expect(order).toEqual(['SIGTERM', 'delay', '0', 'SIGKILL']);
  });

  it('never throws even if the final SIGKILL races the process exit', async () => {
    const kill: PidKiller = (_pid, signal) => {
      if (signal === 'SIGKILL') {
        const err = new Error('ESRCH') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      }
      // SIGTERM ok; signal 0 reports still-alive.
    };

    await expect(terminateDaemonPid(7, kill, noDelay)).resolves.toBeUndefined();
  });
});
