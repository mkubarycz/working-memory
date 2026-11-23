import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('rejects in-repository sender output in a checkout containing spaces before running Azure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'wm feedback checkout '));
  try {
    const script = join(directory, 'scripts/setup-public-feedback.mjs');
    mkdirSync(dirname(script));
    cpSync(fileURLToPath(new URL('../scripts/setup-public-feedback.mjs', import.meta.url)), script);
    expect(() => execFileSync(process.execPath, [script, '--resource-group', 'test', '--account', 'wmtest',
      '--sender-output', join(directory, 'private/sender.json')], { env: { ...process.env, PATH: '' }, stdio: 'pipe' }))
      .toThrow('Keep sender credentials outside the repository.');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
