import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { releaseAssetName, releaseTarget } from '../src/releaseTarget';

const extensionTsPath = join(process.cwd(), 'src', 'extension.ts');
const packageJsonPath = join(process.cwd(), 'package.json');

test('updateToLatest downloads the host-targeted vsix from a tagged GitHub Release', () => {
  const src = readFileSync(extensionTsPath, 'utf8');

  expect(src).toMatch(/['"]release['"],\s*[\s\S]*['"]download['"]/);
  expect(src).toContain("'--pattern'");
  expect(src).toContain('releaseAssetName()');
  expect(src).not.toContain("'*.vsix'");
});

test('updateToLatest no longer pulls from the CI run artifact', () => {
  const src = readFileSync(extensionTsPath, 'utf8');

  // Guard the actual anti-pattern (`gh run download …`), not any occurrence of
  // the word 'run' — unrelated code is fine.
  expect(src).not.toMatch(/['"]run['"],\s*['"]download['"]/);
  expect(src).not.toContain('working-memory-vsix');
  expect(src).not.toMatch(/['"]--name['"]/);
});

test('the command title advertises the latest release, not the CI build', () => {
  const pkg = readFileSync(packageJsonPath, 'utf8');

  expect(pkg).toContain('latest release of Working Memory');
  expect(pkg).not.toContain('latest CI build');
});

test('updateToLatest prompts to reload instead of reloading automatically', () => {
  const src = readFileSync(extensionTsPath, 'utf8');

  // The reload must be gated behind a prompted "Reload Window" action.
  expect(src).toContain('showInformationMessage');
  expect(src).toMatch(/['"]Reload Window['"]/);

  // The reload call must be conditional on the user's choice, not
  // unconditional. Assert there is a guard referencing the choice near the
  // reloadWindow invocation.
  expect(src).toMatch(
    /reloadChoice\s*===\s*['"]Reload Window['"][\s\S]*?reloadWindow/,
  );
});

test('runCommand spawns the bare command via shell:true on Windows', () => {
  const src = readFileSync(extensionTsPath, 'utf8');

  // Node's CVE-2024-27980 fix makes spawn(.cmd, shell:false) throw EINVAL,
  // so on win32 we run the bare command through a shell (PATH resolves the
  // .cmd shim) and quote args ourselves. The `.cmd` suffix approach is gone.
  expect(src).not.toContain('${command}.cmd');
  expect(src).toContain('shell: isWin');
  // Args are double-quoted with embedded quotes escaped to handle spaces
  // and prevent injection.
  expect(src).toMatch(/args\.map\([\s\S]*replace\(\/"\/g/);
});

test.each([
  ['darwin', 'arm64', 'working-memory-darwin-arm64.vsix'],
  ['darwin', 'x64', 'working-memory-darwin-x64.vsix'],
  ['linux', 'x64', 'working-memory-linux-x64.vsix'],
  ['win32', 'x64', 'working-memory-win32-x64.vsix'],
] as const)('maps %s-%s to its published release asset', (platform, arch, asset) => {
  expect(releaseAssetName(platform, arch)).toBe(asset);
});

test('rejects hosts for which no release artifact is published', () => {
  expect(() => releaseTarget('linux', 'arm64')).toThrow(
    'no published Working Memory release supports linux-arm64',
  );
});
