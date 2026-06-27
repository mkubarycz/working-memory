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
