import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export const STABLE_DESKTOP_APP = '/Applications/Working Memory.app';

export interface DesktopLaunchPaths {
  cwd: string;
  electron: string;
  main: string;
}

export function desktopLaunchArgs(
  paths: DesktopLaunchPaths,
  deepLink?: string,
): string[] {
  return deepLink ? [paths.main, deepLink] : [paths.main];
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

function launchDesktop(
  extensionPath: string,
  deepLink?: string,
): Promise<void> {
  if (process.platform === 'darwin' && existsSync(STABLE_DESKTOP_APP)) {
    return new Promise((resolve, reject) => {
      const args = ['-a', STABLE_DESKTOP_APP];
      if (deepLink) args.push(deepLink);
      const child = spawn('/usr/bin/open', args, {
        detached: true,
        stdio: 'ignore',
      });
      child.once('error', reject);
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
  const paths = resolveDesktopLaunchPaths(extensionPath);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;

  return new Promise((resolve, reject) => {
    const child = spawn(
      paths.electron,
      desktopLaunchArgs(paths, deepLink),
      {
      cwd: paths.cwd,
      detached: true,
      env,
      stdio: 'ignore',
      },
    );
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

export function launchDesktopUi(extensionPath: string): Promise<void> {
  return launchDesktop(extensionPath);
}

export function launchDesktopDeepLink(
  extensionPath: string,
  kind: string,
  identifier: string,
): Promise<void> {
  return launchDesktop(
    extensionPath,
    `working-memory://open/${kind}/${encodeURIComponent(identifier)}`,
  );
}
