import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { renderLaunchdPlist, launchAgentPlistPath } from '../src/launcher/launchd';
import { getLauncher, NotImplementedLauncherError } from '../src/launcher';

describe('renderLaunchdPlist', () => {
  const plist = renderLaunchdPlist({
    nodePath: '/usr/local/bin/node',
    scriptPath: '/opt/wm/out/control-plane/index.js',
    nodeArgs: ['--experimental-sqlite'],
    env: { WM_CONTROL_PLANE_HOME: '/Users/n/Library/Application Support/WorkingMemory' },
    stdoutPath: '/tmp/wm-cp.out.log',
    stderrPath: '/tmp/wm-cp.err.log',
    workingDirectory: '/opt/wm',
  });

  it('is a well-formed plist with the reverse-DNS label', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(plist).toContain('<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"');
    expect(plist).toContain('<plist version="1.0">');
    expect(plist).toContain('<key>Label</key>');
    expect(plist).toContain('<string>com.kubarycz.working-memory.control-plane</string>');
    expect(plist.trimEnd().endsWith('</plist>')).toBe(true);
  });

  it('lists node, flags, then the script in ProgramArguments order', () => {
    const node = plist.indexOf('<string>/usr/local/bin/node</string>');
    const flag = plist.indexOf('<string>--experimental-sqlite</string>');
    const script = plist.indexOf('<string>/opt/wm/out/control-plane/index.js</string>');
    expect(node).toBeGreaterThan(-1);
    expect(flag).toBeGreaterThan(node);
    expect(script).toBeGreaterThan(flag);
  });

  it('opts into RunAtLoad and KeepAlive', () => {
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<true/>');
  });

  it('renders EnvironmentVariables, log paths, and working directory', () => {
    expect(plist).toContain('<key>EnvironmentVariables</key>');
    expect(plist).toContain('<key>WM_CONTROL_PLANE_HOME</key>');
    expect(plist).toContain('<key>StandardOutPath</key>');
    expect(plist).toContain('<string>/tmp/wm-cp.out.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key>');
    expect(plist).toContain('<string>/tmp/wm-cp.err.log</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>');
    expect(plist).toContain('<string>/opt/wm</string>');
  });

  it('omits optional sections when not supplied', () => {
    const minimal = renderLaunchdPlist({ nodePath: '/usr/bin/node', scriptPath: '/x/index.js' });
    expect(minimal).not.toContain('EnvironmentVariables');
    expect(minimal).not.toContain('StandardOutPath');
    expect(minimal).not.toContain('WorkingDirectory');
  });

  it('XML-escapes special characters in values', () => {
    const p = renderLaunchdPlist({ nodePath: '/usr/bin/node', scriptPath: '/x/a&b<c>"d".js' });
    expect(p).toContain('/x/a&amp;b&lt;c&gt;&quot;d&quot;.js');
    expect(p).not.toContain('a&b<c>');
  });

  it('honors a custom label', () => {
    const p = renderLaunchdPlist({ nodePath: 'n', scriptPath: 's', label: 'com.example.custom' });
    expect(p).toContain('<string>com.example.custom</string>');
  });
});

describe('launchAgentPlistPath', () => {
  it('is under ~/Library/LaunchAgents', () => {
    const home = path.join('/Users', 'n');
    expect(launchAgentPlistPath('com.example.foo', home)).toBe(
      path.join(home, 'Library', 'LaunchAgents', 'com.example.foo.plist'),
    );
  });
});

describe('getLauncher', () => {
  it('returns the launchd adapter on darwin', () => {
    const launcher = getLauncher('darwin');
    expect(launcher.platform).toBe('darwin');
    expect(launcher.label).toBe('com.kubarycz.working-memory.control-plane');
  });

  it('stubs the Windows Task Scheduler adapter (throws on use)', () => {
    const launcher = getLauncher('win32');
    expect(launcher.platform).toBe('win32');
    expect(() => launcher.install({ nodePath: 'node', scriptPath: 's' })).toThrow(
      NotImplementedLauncherError,
    );
    expect(() => launcher.status()).toThrow(NotImplementedLauncherError);
  });

  it('stubs the Linux systemd adapter (throws on use)', () => {
    const launcher = getLauncher('linux');
    expect(launcher.platform).toBe('linux');
    expect(() => launcher.uninstall()).toThrow(NotImplementedLauncherError);
  });
});
