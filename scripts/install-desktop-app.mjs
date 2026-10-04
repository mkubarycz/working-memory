import {
  cpSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.env.CI) {
  console.log('install-desktop-app: skipped outside a local macOS build');
  process.exit(0);
}

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(
  repoRoot,
  'desktop-ui',
  'runtime',
  'application',
  'Working Memory.app',
);
const applicationsDirectory = process.env.WM_DESKTOP_APPLICATIONS_DIR || '/Applications';
const destination = join(applicationsDirectory, 'Working Memory.app');
const staged = join(applicationsDirectory, `.Working Memory.app.install-${process.pid}`);

if (!existsSync(source)) {
  throw new Error(
    'The prepared Working Memory app is missing; run prepare-desktop-runtime first.',
  );
}

mkdirSync(applicationsDirectory, { recursive: true });
rmSync(staged, { recursive: true, force: true });

try {
  cpSync(source, staged, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
  rmSync(destination, { recursive: true, force: true });
  renameSync(staged, destination);
  const clearedAttributes = spawnSync('/usr/bin/xattr', ['-cr', destination], {
    encoding: 'utf8',
  });
  if (clearedAttributes.status !== 0) {
    throw new Error(
      `Unable to clear installed app metadata: ${clearedAttributes.stderr || clearedAttributes.stdout}`,
    );
  }
  const signed = spawnSync(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', destination],
    { encoding: 'utf8' },
  );
  if (signed.status !== 0) {
    throw new Error(`Unable to sign installed app: ${signed.stderr || signed.stdout}`);
  }
} catch (error) {
  rmSync(staged, { recursive: true, force: true });
  throw error;
}

console.log(`install-desktop-app: updated ${destination} without restarting it`);
