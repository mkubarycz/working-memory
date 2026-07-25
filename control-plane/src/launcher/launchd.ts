/**
 * macOS launchd LaunchAgent implementation of the launcher adapter.
 *
 * `renderLaunchdPlist` is a pure function (no filesystem side effects) so the
 * generated manifest can be asserted directly in unit tests. `install()` /
 * `uninstall()` / `status()` wrap `launchctl`, invoked via `execFileSync`
 * (no shell) with fixed arguments — never string-interpolated user input.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LAUNCHD_LABEL } from '../config.js';
import type {
  LauncherAdapter,
  LauncherInstallOptions,
  LauncherStatus,
} from './types.js';

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export interface LaunchdPlistOptions extends LauncherInstallOptions {
  /** Reverse-DNS LaunchAgent label. Defaults to LAUNCHD_LABEL. */
  label?: string;
}

/**
 * Render a launchd LaunchAgent property list. Pure — returns the plist XML as
 * a string with no I/O.
 */
export function renderLaunchdPlist(opts: LaunchdPlistOptions): string {
  const label = opts.label ?? LAUNCHD_LABEL;
  const programArguments = [opts.nodePath, ...(opts.nodeArgs ?? []), opts.scriptPath];

  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push(
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  );
  lines.push('<plist version="1.0">');
  lines.push('<dict>');

  lines.push('  <key>Label</key>');
  lines.push(`  <string>${xmlEscape(label)}</string>`);

  lines.push('  <key>ProgramArguments</key>');
  lines.push('  <array>');
  for (const arg of programArguments) {
    lines.push(`    <string>${xmlEscape(arg)}</string>`);
  }
  lines.push('  </array>');

  lines.push('  <key>RunAtLoad</key>');
  lines.push('  <true/>');
  lines.push('  <key>KeepAlive</key>');
  lines.push('  <true/>');

  if (opts.workingDirectory) {
    lines.push('  <key>WorkingDirectory</key>');
    lines.push(`  <string>${xmlEscape(opts.workingDirectory)}</string>`);
  }

  const envKeys = opts.env ? Object.keys(opts.env) : [];
  if (envKeys.length > 0) {
    lines.push('  <key>EnvironmentVariables</key>');
    lines.push('  <dict>');
    for (const key of envKeys) {
      lines.push(`    <key>${xmlEscape(key)}</key>`);
      lines.push(`    <string>${xmlEscape(opts.env![key])}</string>`);
    }
    lines.push('  </dict>');
  }

  if (opts.stdoutPath) {
    lines.push('  <key>StandardOutPath</key>');
    lines.push(`  <string>${xmlEscape(opts.stdoutPath)}</string>`);
  }
  if (opts.stderrPath) {
    lines.push('  <key>StandardErrorPath</key>');
    lines.push(`  <string>${xmlEscape(opts.stderrPath)}</string>`);
  }

  lines.push('</dict>');
  lines.push('</plist>');
  return lines.join('\n') + '\n';
}

/** Default LaunchAgent plist path: `~/Library/LaunchAgents/<label>.plist`. */
export function launchAgentPlistPath(
  label: string = LAUNCHD_LABEL,
  homedir: string = os.homedir(),
): string {
  return path.join(homedir, 'Library', 'LaunchAgents', `${label}.plist`);
}

export class LaunchdLauncher implements LauncherAdapter {
  readonly platform: NodeJS.Platform = 'darwin';
  readonly label: string;
  private readonly plistPath: string;

  constructor(label: string = LAUNCHD_LABEL, homedir: string = os.homedir()) {
    this.label = label;
    this.plistPath = launchAgentPlistPath(label, homedir);
  }

  install(opts: LauncherInstallOptions): void {
    const plist = renderLaunchdPlist({ ...opts, label: this.label });
    fs.mkdirSync(path.dirname(this.plistPath), { recursive: true });
    fs.writeFileSync(this.plistPath, plist);
    // Best-effort load into the per-user domain; the written plist is the
    // durable artifact, so a launchctl hiccup is non-fatal.
    try {
      execFileSync('launchctl', ['load', '-w', this.plistPath], { stdio: 'ignore' });
    } catch {
      // Already loaded, or launchctl unavailable — ignore.
    }
  }

  uninstall(): void {
    try {
      execFileSync('launchctl', ['unload', '-w', this.plistPath], { stdio: 'ignore' });
    } catch {
      // Not loaded — ignore.
    }
    fs.rmSync(this.plistPath, { force: true });
  }

  status(): LauncherStatus {
    const installed = fs.existsSync(this.plistPath);
    let running: boolean | undefined;
    try {
      execFileSync('launchctl', ['list', this.label], { stdio: 'ignore' });
      running = true;
    } catch {
      running = installed ? false : undefined;
    }
    return { installed, running, detail: this.plistPath };
  }
}
