import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWorkspaceVersion } from './release-version.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'desktop-ui');
const version = resolveWorkspaceVersion({ cwd: repoRoot });
const env = { ...process.env, WM_DATA_TIER_VERSION: version };
const packageBuild = process.argv[2] === '--package';
const args = process.argv.slice(packageBuild ? 3 : 2);
if (packageBuild && args.some(arg => /^(?:-c|--config)\.extraMetadata\.version(?:=|$)/.test(arg))) {
  throw new Error('Desktop versions are resolved from Git; do not override extraMetadata.version.');
}
const run = (script, args = []) => execFileSync(process.execPath, [script, ...args], {
  cwd: desktopRoot, env, stdio: 'inherit',
});

console.log(`Building Working Memory ${version}`);
run(join(desktopRoot, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), ['build']);
run(join(repoRoot, 'scripts', 'prepare-data-tier-bundle.mjs'));
if (packageBuild) {
  run(join(desktopRoot, 'node_modules', 'electron-builder', 'cli.js'), [
    '--publish', 'never', ...args, `-c.extraMetadata.version=${version}`,
  ]);
} else {
  run(join(repoRoot, 'scripts', 'prepare-desktop-runtime.mjs'));
  run(join(repoRoot, 'scripts', 'install-desktop-app.mjs'), args);
}
