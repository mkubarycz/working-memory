// Installer builds ship an image, never a Docker build context or npm install.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspaceVersion } from './release-version.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(repoRoot, 'desktop-ui', 'build', 'data-tier');
const suppliedArchive = process.env.WM_DATA_TIER_IMAGE_ARCHIVE;
const version = resolveWorkspaceVersion({ cwd: repoRoot });

if (suppliedArchive && resolve(suppliedArchive) === join(destination, 'image.tar')) {
  throw new Error('WM_DATA_TIER_IMAGE_ARCHIVE must be outside the staging directory.');
}
rmSync(destination, { recursive: true, force: true });
mkdirSync(join(destination, 'observability'), { recursive: true });
cpSync(join(repoRoot, 'deploy', 'observability', 'compose.yaml'), join(destination, 'observability', 'compose.yaml'));

if (suppliedArchive) {
  cpSync(suppliedArchive, join(destination, 'image.tar'));
} else {
  const image = `working-memory-control-plane:${version}`;
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  execFileSync('docker', ['build', '--platform', platform, '--build-arg', `WM_BUILD_VERSION=${version}`, '--tag', image, repoRoot], { stdio: 'inherit' });
  execFileSync('docker', ['save', '--output', join(destination, 'image.tar'), image], { stdio: 'inherit' });
}
console.log(`prepare-data-tier-bundle: staged ${version} prebuilt image in ${destination}`);
