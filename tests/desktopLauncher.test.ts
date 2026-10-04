import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  desktopLaunchArgs,
  resolveDesktopLaunchPaths,
  STABLE_DESKTOP_APP,
} from '../src/desktopLauncher';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveDesktopLaunchPaths', () => {
  it('uses the stable macOS application path', () => {
    expect(STABLE_DESKTOP_APP).toBe('/Applications/Working Memory.app');
  });

  it('passes a desktop deep link after the Electron entry point', () => {
    expect(desktopLaunchArgs(
      { cwd: '/desktop', electron: '/electron', main: '/desktop/main.js' },
      'working-memory://open/topic/chat-links',
    )).toEqual([
      '/desktop/main.js',
      'working-memory://open/topic/chat-links',
    ]);
  });

  it('resolves the packaged Electron executable and desktop entry point', () => {
    const root = mkdtempSync(join(tmpdir(), 'wm-desktop-launcher-'));
    roots.push(root);
    const desktopRoot = join(root, 'desktop-ui');
    const runtimeRoot = join(desktopRoot, 'runtime');
    const executable = join('Electron.app', 'Contents', 'MacOS', 'Electron');
    const electron = join(runtimeRoot, 'electron', executable);
    const main = join(desktopRoot, 'out', 'main', 'index.js');
    mkdirSync(join(electron, '..'), { recursive: true });
    mkdirSync(join(main, '..'), { recursive: true });
    writeFileSync(
      join(runtimeRoot, 'launch.json'),
      JSON.stringify({
        platform: process.platform,
        arch: process.arch,
        electron: join('electron', executable),
      }),
    );
    writeFileSync(electron, '');
    writeFileSync(main, '');

    expect(resolveDesktopLaunchPaths(root)).toEqual({
      cwd: desktopRoot,
      electron,
      main,
    });
  });

  describe('desktop UI command contribution', () => {
    it('places the launcher in the Workstreams view title navigation', () => {
      const packageJson = JSON.parse(
        readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
      ) as {
        contributes: {
          commands: Array<{ command: string; icon?: string }>;
          menus: { 'view/title': Array<{ command: string; when?: string; group?: string }> };
        };
      };

      expect(packageJson.contributes.commands).toContainEqual(
        expect.objectContaining({
          command: 'working-memory.openDesktopUi',
          icon: '$(multiple-windows)',
        }),
      );
      expect(packageJson.contributes.menus['view/title']).toContainEqual({
        command: 'working-memory.openDesktopUi',
        when: 'view == workingMemory.workstreams',
        group: 'navigation',
      });
    });
  });

  it('reports a missing packaged desktop runtime', () => {
    const root = mkdtempSync(join(tmpdir(), 'wm-desktop-launcher-'));
    roots.push(root);

    expect(() => resolveDesktopLaunchPaths(root)).toThrow(
      'the packaged desktop UI runtime is missing',
    );
  });

  it('rejects a runtime built for a different platform', () => {
    const root = mkdtempSync(join(tmpdir(), 'wm-desktop-launcher-'));
    roots.push(root);
    const runtimeRoot = join(root, 'desktop-ui', 'runtime');
    const main = join(root, 'desktop-ui', 'out', 'main', 'index.js');
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(join(main, '..'), { recursive: true });
    writeFileSync(
      join(runtimeRoot, 'launch.json'),
      JSON.stringify({
        platform: process.platform === 'darwin' ? 'linux' : 'darwin',
        arch: process.arch,
        electron: 'electron/Electron',
      }),
    );
    writeFileSync(main, '');

    expect(() => resolveDesktopLaunchPaths(root)).toThrow(
      `the packaged desktop UI runtime does not support ${process.platform}-${process.arch}`,
    );
  });
});
