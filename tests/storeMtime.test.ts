/**
 * Unit tests for `maxMtimeMs` (feature:panel-auto-refresh).
 *
 * The helper backs the panel auto-refresh poll: it returns the newest mtime
 * across the daemon's store files, ignoring any that don't exist yet, so a
 * missing `-wal` (checkpointed / not created) never throws and never masks a
 * real write to the main db file.
 */

import { test, expect } from 'vitest';

import { maxMtimeMs } from '../src/storeMtime';

const WAL = '/store/journal.sqlite-wal';
const DB = '/store/journal.sqlite';

function fakeStat(mtimes: Record<string, number>) {
  return (p: string): { mtimeMs: number } => {
    if (!(p in mtimes)) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return { mtimeMs: mtimes[p] };
  };
}

test('returns the greatest mtimeMs across all present files', () => {
  const stat = fakeStat({ [WAL]: 100, [DB]: 250 });
  expect(maxMtimeMs([WAL, DB], stat)).toBe(250);
});

test('ignores a missing file instead of throwing', () => {
  // Only the WAL exists (main db not yet checkpointed into existence).
  const stat = fakeStat({ [WAL]: 42 });
  expect(maxMtimeMs([WAL, DB], stat)).toBe(42);
});

test('returns 0 when none of the files can be stat\'d', () => {
  const stat = fakeStat({});
  expect(maxMtimeMs([WAL, DB], stat)).toBe(0);
});

test('picks up a newer WAL over an older main db (the common write case)', () => {
  const stat = fakeStat({ [WAL]: 900, [DB]: 100 });
  expect(maxMtimeMs([WAL, DB], stat)).toBe(900);
});
