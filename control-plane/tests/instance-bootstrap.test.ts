import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { ensureInstanceBootstrap } from '../src/instanceBootstrap';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it('creates a private bootstrap once and refuses unsafe replacement files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wm-instance-bootstrap-'));
  directories.push(directory);
  const file = join(directory, 'instance.secret');
  const token = ensureInstanceBootstrap(file);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(ensureInstanceBootstrap(file)).toBe(token);
  expect(readFileSync(file, 'utf8')).toBe(token);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  chmodSync(file, 0o644);
  expect(() => ensureInstanceBootstrap(file)).toThrow('Unsafe or unavailable');
  const link = join(directory, 'linked.secret');
  symlinkSync(file, link);
  expect(() => ensureInstanceBootstrap(link)).toThrow('Unsafe or unavailable');
});
