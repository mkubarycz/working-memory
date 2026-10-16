// Installer builds ship an image, never a Docker build context or npm install.
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(repoRoot, 'desktop-ui', 'build', 'data-tier');
const suppliedArchive = process.env.WM_DATA_TIER_IMAGE_ARCHIVE;

if (suppliedArchive && resolve(suppliedArchive) === join(destination, 'image.tar')) {
  throw new Error('WM_DATA_TIER_IMAGE_ARCHIVE must be outside the staging directory.');
}
rmSync(destination, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });

if (suppliedArchive) {
  cpSync(suppliedArchive, join(destination, 'image.tar'));
} else {
  const version = process.env.WM_DATA_TIER_VERSION
    || JSON.parse(readFileSync(join(repoRoot, 'desktop-ui', 'package.json'), 'utf8')).version;
  const image = `working-memory-control-plane:${version}`;
  const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
  execFileSync('docker', ['build', '--platform', platform, '--tag', image, repoRoot], { stdio: 'inherit' });
  execFileSync('docker', ['save', '--output', join(destination, 'image.tar'), image], { stdio: 'inherit' });
}
console.log(`prepare-data-tier-bundle: staged prebuilt image in ${destination}`);
