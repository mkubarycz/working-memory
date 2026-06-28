import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const releaseYmlPath = join(
  process.cwd(),
  '.github',
  'workflows',
  'release.yml',
);
const buildYmlPath = join(process.cwd(), '.github', 'workflows', 'build.yml');

test('release workflow triggers on v* tag pushes', () => {
  const yml = readFileSync(releaseYmlPath, 'utf8');

  expect(yml).toMatch(/on:\s*[\s\S]*push:/);
  expect(yml).toMatch(/tags:\s*[\s\S]*-\s*['"]v\*['"]/);
});

test('release workflow checks out full history for ancestry checks', () => {
  const yml = readFileSync(releaseYmlPath, 'utf8');

  expect(yml).toMatch(/fetch-depth:\s*0/);
});

test('release workflow refuses tags whose commit is not on main', () => {
  const yml = readFileSync(releaseYmlPath, 'utf8');

  expect(yml).toMatch(/git\s+merge-base\s+--is-ancestor/);
  expect(yml).toContain('origin/main');
  expect(yml).toMatch(/refusing to release|::error::/);
  expect(yml).toMatch(/exit\s+1/);
});

test('release workflow stamps the version from the tag', () => {
  const yml = readFileSync(releaseYmlPath, 'utf8');

  expect(yml).toContain('Set version from tag');
  expect(yml).toContain('npm version "${GITHUB_REF_NAME#v}"');
  expect(yml).toContain('--no-git-tag-version');
  expect(yml).toContain('--allow-same-version');
});

test('release workflow compiles, tests, and packages the vsix', () => {
  const yml = readFileSync(releaseYmlPath, 'utf8');

  expect(yml).toContain('npm run compile');
  expect(yml).toContain('npm test');
  expect(yml).toContain('vsce package');
});

test('release workflow publishes a GitHub Release with the vsix attached', () => {
  const yml = readFileSync(releaseYmlPath, 'utf8');

  expect(yml).toContain('softprops/action-gh-release');
  expect(yml).toContain('working-memory-*.vsix');
  expect(yml).toContain('working-memory.vsix');
});

test('release workflow grants contents: write permission', () => {
  const yml = readFileSync(releaseYmlPath, 'utf8');

  expect(yml).toMatch(/permissions:\s*[\s\S]*contents:\s*write/);
});

test('bleeding-edge build workflow still exists and triggers on push to main', () => {
  const yml = readFileSync(buildYmlPath, 'utf8');

  expect(yml).toMatch(/on:\s*[\s\S]*push:/);
  expect(yml).toMatch(/branches:\s*[\s\S]*-\s*main/);
});
