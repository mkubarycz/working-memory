import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'wm-desktop-build-'));
  directories.push(directory);
  const cwd = join(directory, 'project');
  const desktop = join(cwd, 'desktop-ui');
  const scripts = join(cwd, 'scripts');
  const log = join(directory, 'calls.jsonl');
  mkdirSync(scripts, { recursive: true });
  mkdirSync(desktop, { recursive: true });
  cpSync(new URL('../.gitignore', import.meta.url), join(cwd, '.gitignore'));
  for (const name of ['build-desktop.mjs', 'release-version.mjs']) {
    cpSync(new URL(`../scripts/${name}`, import.meta.url), join(scripts, name));
  }
  const record = (phase: string) => `import('node:fs').then(async ({ appendFileSync, writeFileSync, rmSync }) => {
    const config = ${JSON.stringify(join(desktop, 'electron.vite.config.1793974393234.mjs'))};
    if (${JSON.stringify(phase)} === 'vite') writeFileSync(config, '// Generated bundled Vite config');
    try {
      const { resolveWorkspaceVersion } = await import(${JSON.stringify(pathToFileURL(join(scripts, 'release-version.mjs')).href)});
      const version = resolveWorkspaceVersion({ cwd: ${JSON.stringify(cwd)} });
      appendFileSync(${JSON.stringify(log)}, JSON.stringify({
        phase: ${JSON.stringify(phase)}, args: process.argv.slice(2), version,
      }) + '\\n');
    } finally {
      if (${JSON.stringify(phase)} === 'vite') rmSync(config);
    }
  });`;
  for (const [phase, filename] of [
    ['vite', 'node_modules/electron-vite/bin/electron-vite.js'],
    ['builder', 'node_modules/electron-builder/cli.js'],
  ]) {
    const path = join(desktop, filename);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, record(phase));
  }
  for (const name of ['prepare-embedding-runtime', 'prepare-data-tier-bundle', 'prepare-desktop-runtime', 'install-desktop-app']) {
    writeFileSync(join(scripts, `${name}.mjs`), record(name));
  }
  const manifest = join(desktop, 'package.json');
  writeFileSync(manifest, JSON.stringify({ version: '1.4.1', type: 'module' }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '--initial-branch=main');
  git('add', '.');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'baseline');
  git('tag', 'v1.7.0');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'local build');
  const version = `1.7.1-dev.g${git('rev-parse', '--short=12', 'HEAD')}`;
  const env = {
    ...process.env, GITHUB_REF_TYPE: undefined, GITHUB_REF_NAME: undefined,
    GITHUB_RUN_NUMBER: undefined, WM_DATA_TIER_VERSION: undefined,
  };
  return { cwd, scripts, log, manifest, env, version };
}

const nativePackageArgs = ['--package', ...(process.platform === 'win32' ? ['--win'] : process.platform === 'darwin' ? ['--mac'] : [])];
it.each([
  { args: [], ci: false },
  { args: nativePackageArgs, ci: false },
  { args: nativePackageArgs, ci: true },
])('uses one Git-derived version through the actual build entry point: %j', ({ args, ci }) => {
  const { cwd, scripts, log, manifest, env, version } = fixture();
  const expected = ci ? '1.7.1-build.131' : version;
  const result = spawnSync(process.execPath, [join(scripts, 'build-desktop.mjs'), ...args], {
    cwd, encoding: 'utf8',
    env: ci ? { ...env, GITHUB_REF_TYPE: 'branch', GITHUB_RUN_NUMBER: '131' } : env,
  });
  expect(result.status, result.stderr).toBe(0);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(calls.map(call => call.version)).toEqual(calls.map(() => expected));
  expect(calls.map(call => call.phase)).toEqual(args.length
    ? ['prepare-embedding-runtime', 'vite', 'prepare-data-tier-bundle', 'builder']
    : ['prepare-embedding-runtime', 'vite', 'prepare-data-tier-bundle', 'prepare-desktop-runtime', 'install-desktop-app']);
  if (args.length) {
    expect(calls.at(-1).args).toEqual(['--publish', 'never', ...args.slice(1), `-c.extraMetadata.version=${expected}`]);
  }
  expect(JSON.parse(readFileSync(manifest, 'utf8')).version).toBe('1.4.1');
});

it.each([
  { flag: '--mac', platform: 'darwin' },
  { flag: '--win', platform: 'win32' },
].filter(target => target.platform !== process.platform))('rejects non-native packaging before build phases: $flag', ({ flag }) => {
  const { cwd, scripts, log, env } = fixture();
  const result = spawnSync(process.execPath, [join(scripts, 'build-desktop.mjs'), '--package', flag], {
    cwd, env, encoding: 'utf8',
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('must be packaged on its native target OS');
  expect(existsSync(log)).toBe(false);
});

it('rejects a manual installer-version override before starting build phases', () => {
  const { cwd, scripts, log, env } = fixture();
  const result = spawnSync(process.execPath, [
    join(scripts, 'build-desktop.mjs'), '--package', '-c.extraMetadata.version=1.4.1',
  ], { cwd, env, encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('do not override extraMetadata.version');
  expect(existsSync(log)).toBe(false);
});
