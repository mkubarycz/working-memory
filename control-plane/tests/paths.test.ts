import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  resolveAppHome,
  storeDir,
  runtimeDir,
  dbPath,
  lockPath,
  portFilePath,
} from '../src/paths';

// Expected values are built with path.join so assertions are host-agnostic
// (a POSIX CI host and a Windows host produce matching separators on both
// sides of the comparison).

describe('resolveAppHome', () => {
  it('honors the WM_CONTROL_PLANE_HOME override above all platform logic', () => {
    const home = resolveAppHome({
      platform: 'linux',
      homedir: '/home/nobody',
      env: { WM_CONTROL_PLANE_HOME: path.join('/tmp', 'wm-home'), XDG_DATA_HOME: '/should/be/ignored' },
    });
    expect(home).toBe(path.resolve(path.join('/tmp', 'wm-home')));
  });

  it('resolves the macOS Application Support path', () => {
    const home = resolveAppHome({ platform: 'darwin', homedir: path.join('/Users', 'nobody'), env: {} });
    expect(home).toBe(
      path.join('/Users', 'nobody', 'Library', 'Application Support', 'WorkingMemory'),
    );
  });

  it('resolves the Windows %LOCALAPPDATA% path', () => {
    const base = path.join('C:\\Users\\n', 'AppData', 'Local');
    const home = resolveAppHome({ platform: 'win32', homedir: 'C:\\Users\\n', env: { LOCALAPPDATA: base } });
    expect(home).toBe(path.join(base, 'WorkingMemory'));
  });

  it('falls back to <homedir>/AppData/Local on Windows without %LOCALAPPDATA%', () => {
    const home = resolveAppHome({ platform: 'win32', homedir: path.join('C:', 'Users', 'n'), env: {} });
    expect(home).toBe(path.join('C:', 'Users', 'n', 'AppData', 'Local', 'WorkingMemory'));
  });

  it('resolves the Linux XDG_DATA_HOME path', () => {
    const xdg = path.join('/home', 'n', '.xdg');
    const home = resolveAppHome({ platform: 'linux', homedir: '/home/n', env: { XDG_DATA_HOME: xdg } });
    expect(home).toBe(path.join(xdg, 'working-memory'));
  });

  it('falls back to ~/.local/share on Linux without XDG_DATA_HOME', () => {
    const home = resolveAppHome({ platform: 'linux', homedir: path.join('/home', 'n'), env: {} });
    expect(home).toBe(path.join('/home', 'n', '.local', 'share', 'working-memory'));
  });
});

describe('derived paths', () => {
  const input = {
    platform: 'darwin' as NodeJS.Platform,
    homedir: path.join('/Users', 'nobody'),
    env: { WM_CONTROL_PLANE_HOME: path.join('/tmp', 'wm-home') },
  };
  const home = path.resolve(path.join('/tmp', 'wm-home'));

  it('puts the store + database at the app home', () => {
    expect(storeDir(input)).toBe(home);
    expect(dbPath(input)).toBe(path.join(home, 'journal.sqlite'));
  });

  it('puts the lock + port files under <home>/run', () => {
    expect(runtimeDir(input)).toBe(path.join(home, 'run'));
    expect(lockPath(input)).toBe(path.join(home, 'run', 'control-plane.lock'));
    expect(portFilePath(input)).toBe(path.join(home, 'run', 'control-plane.port.json'));
  });
});
