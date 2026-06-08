import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { findLatestVsix } from '../src/vsix';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

test('returns null when no vsix exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'working-memory-vsix-test-'));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'readme.txt'), 'nope');

  expect(findLatestVsix(dir)).toBeNull();
});

test('finds newest vsix including nested files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'working-memory-vsix-test-'));
  tempDirs.push(dir);

  const oldVsix = join(dir, 'old.vsix');
  writeFileSync(oldVsix, 'old');
  const oldDate = new Date('2020-01-01T00:00:00Z');
  utimesSync(oldVsix, oldDate, oldDate);

  const nested = join(dir, 'artifact');
  mkdirSync(nested);
  const newVsix = join(nested, 'new.vsix');
  writeFileSync(newVsix, 'new');
  const newDate = new Date('2021-01-01T00:00:00Z');
  utimesSync(newVsix, newDate, newDate);

  expect(findLatestVsix(dir)).toBe(newVsix);
});
