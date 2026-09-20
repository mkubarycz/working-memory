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
  expect(yml).toContain('npm ci --prefix desktop-ui');
  expect(yml).toContain('npm run compile:desktop');
  expect(yml).toContain('npm test');
  expect(yml).toContain('vsce package');
});

test('release workflow publishes platform-targeted GitHub Release assets', () => {
  const yml = readFileSync(releaseYmlPath, 'utf8');

  expect(yml).toContain('softprops/action-gh-release');
  for (const target of [
    'linux-x64',
    'win32-x64',
    'darwin-x64',
    'darwin-arm64',
  ]) {
    expect(yml).toContain(`target: ${target}`);
  }
  expect(yml).toContain('working-memory-${{ matrix.target }}.vsix');
  expect(yml).toContain('npm_config_platform: ${{ matrix.platform }}');
  expect(yml).toContain('npm_config_arch: ${{ matrix.arch }}');
  expect(yml).toContain('WM_DESKTOP_PLATFORM: ${{ matrix.platform }}');
  expect(yml).toContain('WM_DESKTOP_ARCH: ${{ matrix.arch }}');
  expect(yml).not.toMatch(/working-memory\.vsix/);
});

test('release workflow grants contents: write permission', () => {
  const yml = readFileSync(releaseYmlPath, 'utf8');

  expect(yml).toMatch(/permissions:\s*[\s\S]*contents:\s*write/);
});

test('release is published only after every targeted package succeeds', () => {
  const yml = readFileSync(releaseYmlPath, 'utf8');

  expect(yml).toMatch(/publish:\s*[\s\S]*needs:\s*build/);
  expect(yml).toContain('uses: actions/upload-artifact@v4');
  expect(yml).toContain('uses: actions/download-artifact@v4');
  expect(yml).toContain('pattern: release-vsix-*');
  expect(yml).toContain('merge-multiple: true');
});

test('bleeding-edge build workflow still exists and triggers on push to main', () => {
  const yml = readFileSync(buildYmlPath, 'utf8');

  expect(yml).toMatch(/on:\s*[\s\S]*push:/);
  expect(yml).toMatch(/branches:\s*[\s\S]*-\s*main/);
});

test('clean main builds install and build the desktop UI before packaging', () => {
  const yml = readFileSync(buildYmlPath, 'utf8');

  const install = yml.indexOf('npm ci --prefix desktop-ui');
  const build = yml.indexOf('npm run compile:desktop');
  const packageVsix = yml.indexOf('vsce package');
  expect(install).toBeGreaterThan(-1);
  expect(build).toBeGreaterThan(install);
  expect(packageVsix).toBeGreaterThan(build);
  expect(yml).toContain('--target linux-x64');
  expect(yml).toContain('--out working-memory-linux-x64.vsix');
});
