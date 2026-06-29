import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const extensionTsPath = join(process.cwd(), 'src', 'extension.ts');
const packageJsonPath = join(process.cwd(), 'package.json');

test('updateToLatest downloads the vsix from a tagged GitHub Release', () => {
  const src = readFileSync(extensionTsPath, 'utf8');

  // The command must shell out to `gh release download` with a `--pattern`
  // glob for the vsix artifact.
  expect(src).toMatch(/['"]release['"],\s*[\s\S]*['"]download['"]/);
  expect(src).toContain("'--pattern'");
  expect(src).toContain("'*.vsix'");
});

test('updateToLatest no longer pulls from the CI run artifact', () => {
  const src = readFileSync(extensionTsPath, 'utf8');

  expect(src).not.toContain("'run'");
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
