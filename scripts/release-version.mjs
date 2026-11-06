import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const core = '(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)';
const stableTag = new RegExp(`^v${core}$`);
const releaseTag = new RegExp(`^v${core}(?:-([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`);

export function resolveReleaseVersion({ refType, refName, runNumber, tags, localCommit, dirty = false }) {
  const stable = tags.filter((tag) => stableTag.test(tag)).map((tag) =>
    stableTag.exec(tag).slice(1).map(BigInt));
  stable.sort((a, b) => {
    for (let i = 0; i < 3; i += 1) {
      if (a[i] !== b[i]) return a[i] > b[i] ? -1 : 1;
    }
    return 0;
  });
  if (refType === 'tag') {
    const match = releaseTag.exec(refName);
    if (!match || match[4]?.split('.').some((part) => /^0[0-9]+$/.test(part))) {
      throw new Error(`Invalid release tag ${JSON.stringify(refName)}; use vX.Y.Z or vX.Y.Z-rc.N.`);
    }
    const candidate = match.slice(1, 4).map(BigInt);
    if (stable[0]) {
      const difference = candidate.findIndex((part, i) => part !== stable[0][i]);
      if ((difference >= 0 && candidate[difference] < stable[0][difference])
        || (difference === -1 && match[4])) {
        throw new Error(`Release tag ${refName} would regress the reachable Stable version.`);
      }
    }
    return refName.slice(1);
  }
  if (!stable[0]) {
    throw new Error('No reachable vX.Y.Z release tag; fetch full history and tags before building.');
  }
  const [major, minor, patch] = stable[0];
  if (localCommit !== undefined) {
    if (typeof localCommit !== 'string' || !/^[0-9a-f]{7,40}$/.test(localCommit)) {
      throw new Error('A valid Git commit is required for a local build.');
    }
    return `${major}.${minor}.${patch + 1n}-dev.g${localCommit}${dirty ? '.dirty' : ''}`;
  }
  if (!/^[1-9][0-9]*$/.test(runNumber ?? '')) {
    throw new Error('A positive GitHub run number is required for an untagged installer build.');
  }
  return `${major}.${minor}.${patch + 1n}-build.${runNumber}`;
}

export function resolveWorkspaceVersion({ cwd = process.cwd(), env = process.env } = {}) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  const tags = git('tag', '--merged', 'HEAD', '--list', 'v*').split('\n');
  const ci = env.GITHUB_REF_TYPE !== undefined || env.GITHUB_RUN_NUMBER !== undefined;
  const version = resolveReleaseVersion(ci ? {
    refType: env.GITHUB_REF_TYPE, refName: env.GITHUB_REF_NAME, runNumber: env.GITHUB_RUN_NUMBER, tags,
  } : {
    tags, localCommit: git('rev-parse', '--short=12', 'HEAD'),
    dirty: git('status', '--porcelain', '--untracked-files=normal') !== '',
  });
  if (env.WM_DATA_TIER_VERSION !== undefined && env.WM_DATA_TIER_VERSION !== version) {
    throw new Error(`WM_DATA_TIER_VERSION must match the Git-derived build version ${version}.`);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = resolveWorkspaceVersion();
  console.log(version);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\n`);
  }
}
