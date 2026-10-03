import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export interface DesktopLaunchPaths {
  cwd: string;
  electron: string;
  main: string;
}

export function resolveDesktopLaunchPaths(extensionPath: string): DesktopLaunchPaths {
  const cwd = join(extensionPath, 'desktop-ui');
  const runtimeRoot = join(cwd, 'runtime');
  const manifestPath = join(runtimeRoot, 'launch.json');
  const main = join(cwd, 'out', 'main', 'index.js');

  if (!existsSync(manifestPath) || !existsSync(main)) {
    throw new Error('the packaged desktop UI runtime is missing');
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    platform?: unknown;
    arch?: unknown;
    electron?: unknown;
  };
  if (
    manifest.platform !== process.platform ||
    manifest.arch !== process.arch ||
    typeof manifest.electron !== 'string' ||
    !manifest.electron
  ) {
    throw new Error(
      `the packaged desktop UI runtime does not support ${process.platform}-${process.arch}`,
    );
  }

  const electron = resolve(runtimeRoot, manifest.electron);
  const relativeElectron = relative(runtimeRoot, electron);
  if (
    relativeElectron.startsWith('..') ||
    isAbsolute(relativeElectron) ||
    !existsSync(electron)
  ) {
    throw new Error(`the packaged Electron executable was not found at ${electron}`);
  }

  return { cwd, electron, main };
}

export function launchDesktopUi(extensionPath: string): Promise<void> {
  const paths = resolveDesktopLaunchPaths(extensionPath);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;

  return new Promise((resolve, reject) => {
    const child = spawn(paths.electron, [paths.main], {
      cwd: paths.cwd,
      detached: true,
      env,
      stdio: 'ignore',
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
