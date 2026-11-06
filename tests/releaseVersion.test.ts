import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveReleaseVersion, resolveWorkspaceVersion } from '../scripts/release-version.mjs';

describe('release version authority', () => {
  it('builds the requested 1.7.0 release from its tag without consulting manifests', () => {
    expect(resolveReleaseVersion({
      refType: 'tag', refName: 'v1.7.0', tags: ['v1.6.0', 'v1.7.0'],
    })).toBe('1.7.0');
  });

  it('bases untagged builds on the highest reachable stable version, not tag order', () => {
    expect(resolveReleaseVersion({
      refType: 'branch', runNumber: '131',
      tags: ['v1.4.0', 'canary', 'v1.6.0', 'v1.8.0-rc.1', 'v1.5.0'],
    })).toBe('1.6.1-build.131');
    expect(resolveReleaseVersion({
      refType: 'branch', runNumber: '132', tags: ['v1.7.0'],
    })).toBe('1.7.1-build.132');
  });

  it('sorts numeric components rather than lexicographic tag names', () => {
    expect(resolveReleaseVersion({
      runNumber: '2', tags: ['v1.9.9', 'v1.10.0', 'v0.99.99'],
    })).toBe('1.10.1-build.2');
  });

  it('identifies local builds from reachable release history and their Git revision', () => {
    expect(resolveReleaseVersion({ tags: ['v1.4.0', 'v1.7.0'], localCommit: 'abcdef123456' }))
      .toBe('1.7.1-dev.gabcdef123456');
    expect(resolveReleaseVersion({ tags: ['v1.7.0'], localCommit: 'abcdef123456', dirty: true }))
      .toBe('1.7.1-dev.gabcdef123456.dirty');
  });

  it.each(['', '../version', 'not-a-commit', 'ABCDEF123456'])(
    'rejects an invalid local Git revision %s', localCommit => {
      expect(() => resolveReleaseVersion({ tags: ['v1.7.0'], localCommit })).toThrow('valid Git commit');
    },
  );

  it('keeps explicit prerelease tags and supports patch, minor and major releases', () => {
    for (const tag of ['v1.6.1', 'v1.7.0', 'v2.0.0', 'v1.7.0-rc.1']) {
      expect(resolveReleaseVersion({ refType: 'tag', refName: tag, tags: ['v1.6.0'] }))
        .toBe(tag.slice(1));
    }
  });

  it.each(['canary', 'v1.07.0', 'v1.7', 'v1.7.0-rc.01', 'v1.7.0+build.2', 'v1.7.0\nbad'])(
    'rejects malformed or unsupported release tag %s', (refName) => {
      expect(() => resolveReleaseVersion({ refType: 'tag', refName, tags: ['v1.6.0'] }))
        .toThrow('Invalid release tag');
    },
  );

  it.each(['v1.5.9', 'v1.6.0-rc.1'])('rejects a release regression: %s', (refName) => {
    expect(() => resolveReleaseVersion({ refType: 'tag', refName, tags: ['v1.6.0'] }))
      .toThrow('regress');
  });

  it('fails closed without release history rather than falling back to package.json', () => {
    expect(() => resolveReleaseVersion({ runNumber: '130', tags: ['canary', 'v1.7.0-rc.1'] }))
      .toThrow('No reachable');
  });

  it.each([undefined, '', '0', '01', '-1', '130\nversion=1.0.0'])(
    'rejects invalid build number %s', (runNumber) => {
      expect(() => resolveReleaseVersion({ runNumber, tags: ['v1.6.0'] }))
        .toThrow('positive GitHub run number');
    },
  );
});

describe('release version CLI', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('uses only tags reachable from the checkout and writes the workflow output', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wm-release-version-'));
    directories.push(cwd);
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
    git('init', '--initial-branch=main');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'baseline');
    git('tag', 'v1.6.0');
    git('checkout', '-b', 'unrelated');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'future release');
    git('tag', 'v9.0.0');
    git('checkout', 'main');
    const output = join(cwd, 'output');
    const result = spawnSync(process.execPath, [
      fileURLToPath(new URL('../scripts/release-version.mjs', import.meta.url)),
    ], {
      cwd, encoding: 'utf8',
      env: {
        ...process.env, GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main',
        GITHUB_RUN_NUMBER: '130', GITHUB_OUTPUT: output,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('1.6.1-build.130');
    expect(readFileSync(output, 'utf8')).toBe('version=1.6.1-build.130\n');
  });

  it('ignores source-package versions locally and rejects a conflicting build override', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'wm-workspace-version-'));
    directories.push(cwd);
    const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
    git('init', '--initial-branch=main');
    const manifest = join(cwd, 'package.json');
    writeFileSync(manifest, JSON.stringify({ version: '1.4.1' }));
    git('add', 'package.json');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '-m', 'release');
    git('tag', 'v1.7.0');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'local changes');
    const version = `1.7.1-dev.g${git('rev-parse', '--short=12', 'HEAD')}`;
    expect(resolveWorkspaceVersion({ cwd, env: {} })).toBe(version);
    expect(JSON.parse(readFileSync(manifest, 'utf8')).version).toBe('1.4.1');
    writeFileSync(manifest, JSON.stringify({ version: '99.0.0' }));
    expect(resolveWorkspaceVersion({ cwd, env: {} })).toBe(`${version}.dirty`);
    expect(resolveWorkspaceVersion({ cwd, env: { GITHUB_REF_TYPE: 'branch', GITHUB_RUN_NUMBER: '131' } }))
      .toBe('1.7.1-build.131');
    expect(() => resolveWorkspaceVersion({ cwd, env: { WM_DATA_TIER_VERSION: '1.4.1' } }))
      .toThrow('must match the Git-derived');
  });
});
