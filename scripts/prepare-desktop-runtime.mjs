import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = join(repoRoot, 'desktop-ui');
const electronRoot = join(desktopRoot, 'node_modules', 'electron');
const sourceDist = join(electronRoot, 'dist');
const pathFile = join(electronRoot, 'path.txt');
const runtimeRoot = join(desktopRoot, 'runtime');
const targetPlatform = process.env.WM_DESKTOP_PLATFORM || process.platform;
const targetArch = process.env.WM_DESKTOP_ARCH || process.arch;
const expectedExecutables = {
  darwin: 'Electron.app/Contents/MacOS/Electron',
  linux: 'electron',
  win32: 'electron.exe',
};

function materializeSymlinks(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      const target = realpathSync(path);
      const targetStats = statSync(target);
      rmSync(path, { recursive: true, force: true });
      cpSync(target, path, {
        recursive: targetStats.isDirectory(),
        dereference: true,
        preserveTimestamps: true,
      });
      chmodSync(path, targetStats.mode);
    }
    if (statSync(path).isDirectory()) {
      materializeSymlinks(path);
    }
  }
}

if (!existsSync(sourceDist) || !existsSync(pathFile)) {
  throw new Error('Electron is not installed in desktop-ui; run npm install there first.');
}

const executable = readFileSync(pathFile, 'utf8').trim();
if (!executable) {
  throw new Error('Electron path.txt is empty.');
}
const normalizedExecutable = executable.split(sep).join('/');
const expectedExecutable = expectedExecutables[targetPlatform];
if (!expectedExecutable || normalizedExecutable !== expectedExecutable) {
  throw new Error(
    `Installed Electron executable ${normalizedExecutable} does not match target platform ${targetPlatform}.`,
  );
}

const sourceExecutable = resolve(sourceDist, executable);
const sourceRelative = relative(sourceDist, sourceExecutable);
if (sourceRelative.startsWith('..') || !existsSync(sourceExecutable)) {
  throw new Error(`Electron executable is invalid: ${executable}`);
}

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });
cpSync(sourceDist, join(runtimeRoot, 'electron'), {
  recursive: true,
  preserveTimestamps: true,
});
materializeSymlinks(join(runtimeRoot, 'electron'));

writeFileSync(
  join(runtimeRoot, 'launch.json'),
  `${JSON.stringify(
    {
      platform: targetPlatform,
      arch: targetArch,
      electron: `electron/${normalizedExecutable}`,
    },
    null,
    2,
  )}\n`,
);
