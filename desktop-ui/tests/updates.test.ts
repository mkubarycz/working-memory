import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopUpdater, MAC_BUNDLE_IDENTIFIER, macAppBundle } from '../src/main/desktopUpdater';
import type { CommandRunner } from '../src/main/dockerContainerService';
import {
  defaultDesktopChannel,
  fetchUpdateManifest,
  manifestUrl,
  parseBackendImage,
  parseUpdateManifest,
  readUpdateSettings,
  writeUpdateSettings,
} from '../src/main/updateChannels';
import type { UpdateChannel } from '../src/shared/contracts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wm-updates-'));
  roots.push(root);
  return root;
}

const PAYLOAD = Buffer.from('installer bytes');
const SHA = createHash('sha256').update(PAYLOAD).digest('hex');

/** Mirrors the manifest `.github/workflows/release.yml` writes. */
function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: 'canary',
    version: '0.1.1-build.40',
    tag: 'canary',
    commit: 'abc123',
    publishedAt: '2025-01-01T00:00:00.000Z',
    desktop: {
      'darwin-arm64': { file: 'Working-Memory-0.1.1-build.40-mac-arm64.dmg', sha256: SHA, size: PAYLOAD.length },
      'win32-x64': { file: 'Working-Memory-0.1.1-build.40-win-x64.exe', sha256: SHA, size: PAYLOAD.length },
    },
    backend: { image: 'ghcr.io/mkubarycz/working-memory-control-plane:0.1.1-build.40' },
    ...overrides,
  };
}

describe('update channels', () => {
  it('resolves manifest URLs for the rolling canary and the latest stable release', () => {
    expect(manifestUrl('canary', 'https://example.test/releases'))
      .toBe('https://example.test/releases/download/canary/update.json');
    expect(manifestUrl('stable', 'https://example.test/releases'))
      .toBe('https://example.test/releases/latest/download/update.json');
  });

  it('defaults local builds to off, CI builds to canary, and tagged releases to stable', () => {
    expect(defaultDesktopChannel('0.1.1', true)).toBe('off');
    expect(defaultDesktopChannel('0.1.1-build.28', false)).toBe('canary');
    expect(defaultDesktopChannel('0.16.2', false)).toBe('stable');
  });

  it('parses the CI manifest and rejects mismatched channels', () => {
    const parsed = parseUpdateManifest(JSON.stringify(manifest()), 'canary');
    expect(parsed.desktop['darwin-arm64']?.size).toBe(PAYLOAD.length);
    expect(parsed.backend).toEqual({
      version: '0.1.1-build.40',
      image: 'ghcr.io/mkubarycz/working-memory-control-plane:0.1.1-build.40',
    });
    expect(() => parseUpdateManifest(manifest(), 'stable')).toThrow(/reports channel "canary"/);
  });

  it('drops assets with unsafe names or bad digests and backend images from other registries', () => {
    const parsed = parseUpdateManifest(manifest({
      desktop: {
        'darwin-arm64': { file: '../evil.dmg', sha256: SHA, size: 1 },
        'win32-x64': { file: 'ok.exe', sha256: 'nope', size: 1 },
      },
      backend: { image: 'docker.io/someone/working-memory-control-plane:1.0.0' },
    }), 'canary');
    expect(parsed.desktop).toEqual({});
    expect(parsed.backend).toBeNull();
    expect(parseBackendImage('ghcr.io/mkubarycz/working-memory-control-plane:1.2.3')?.version).toBe('1.2.3');
  });

  it('treats a missing manifest as no release and honors the releases URL override', async () => {
    const urls: string[] = [];
    const result = await fetchUpdateManifest('stable', {
      env: { WM_UPDATE_RELEASES_URL: 'http://127.0.0.1:9999/releases/' },
      fetch: async (url) => {
        urls.push(url);
        return new Response('missing', { status: 404 });
      },
    });
    expect(result).toBeNull();
    expect(urls).toEqual(['http://127.0.0.1:9999/releases/latest/download/update.json']);
  });

  it('persists channel settings and falls back to defaults for invalid values', async () => {
    const file = join(tempRoot(), 'updates.json');
    const defaults = { desktopChannel: 'canary', backendChannel: 'canary' } as const;
    expect(await readUpdateSettings(file, defaults)).toEqual(defaults);
    await writeUpdateSettings(file, { desktopChannel: 'stable', backendChannel: 'off' });
    expect(await readUpdateSettings(file, defaults)).toEqual({ desktopChannel: 'stable', backendChannel: 'off' });
    writeFileSync(file, JSON.stringify({ desktopChannel: 'nightly' }));
    expect(await readUpdateSettings(file, defaults)).toEqual(defaults);
  });
});

interface Harness {
  updater: DesktopUpdater;
  root: string;
  commands: Array<{ file: string; args: string[] }>;
  spawned: Array<{ file: string; args: string[] }>;
  saved: UpdateChannel[];
  quit: { count: number };
}

function harness(options: {
  platform: NodeJS.Platform;
  arch?: string;
  channel?: UpdateChannel;
  manifest?: Record<string, unknown>;
  payload?: Buffer;
  bundleIdentifier?: string;
}): Harness {
  const root = tempRoot();
  const commands: Harness['commands'] = [];
  const spawned: Harness['spawned'] = [];
  const saved: UpdateChannel[] = [];
  const quit = { count: 0 };
  const applications = join(root, 'Applications');
  mkdirSync(applications, { recursive: true });
  const runner: CommandRunner = {
    async run(file, args) {
      commands.push({ file, args });
      if (file.endsWith('ditto')) mkdirSync(join(args[1], 'Contents'), { recursive: true });
      if (file.endsWith('plutil')) return { stdout: `${options.bundleIdentifier ?? MAC_BUNDLE_IDENTIFIER}\n`, stderr: '' };
      return { stdout: '', stderr: '' };
    },
  };
  const updater = new DesktopUpdater({
    currentVersion: '0.1.1-build.30',
    channel: options.channel ?? 'canary',
    saveChannel: async (channel) => {
      saved.push(channel);
    },
    downloadDirectory: join(root, 'downloads'),
    executablePath: options.platform === 'darwin'
      ? join(applications, 'Working Memory.app', 'Contents', 'MacOS', 'Working Memory')
      : join(root, 'Programs', 'Working Memory', 'Working Memory.exe'),
    pid: 4242,
    platform: options.platform,
    arch: options.arch ?? (options.platform === 'darwin' ? 'arm64' : 'x64'),
    env: {},
    fetch: async (url) => {
      if (url.endsWith('/update.json')) return new Response(JSON.stringify(options.manifest ?? manifest()));
      return new Response(options.payload ?? PAYLOAD);
    },
    runner,
    spawnDetached: (file, args) => spawned.push({ file, args }),
    quit: () => {
      quit.count += 1;
    },
  });
  return { updater, root, commands, spawned, saved, quit };
}

describe('desktop updater', () => {
  it('finds the app bundle that contains the running executable', () => {
    expect(macAppBundle('/Applications/Working Memory.app/Contents/MacOS/Working Memory'))
      .toBe('/Applications/Working Memory.app');
    expect(macAppBundle('/usr/local/bin/electron')).toBeNull();
  });

  it('reports an available update and stays quiet when already current', async () => {
    const { updater } = harness({ platform: 'win32' });
    const state = await updater.check();
    expect(state.phase).toBe('available');
    expect(state.available?.version).toBe('0.1.1-build.40');
    expect(state.available?.releaseUrl).toBe('https://github.com/mkubarycz/working-memory/releases/tag/canary');

    const current = harness({ platform: 'win32', manifest: manifest({ version: '0.1.1-build.30' }) });
    expect((await current.updater.check()).phase).toBe('up-to-date');
  });

  it('downloads, verifies, and silently runs the Windows installer before quitting', async () => {
    const { updater, spawned, quit, root } = harness({ platform: 'win32' });
    await updater.check();
    const ready = await updater.download();
    expect(ready.phase).toBe('ready');
    const installer = join(root, 'downloads', '0.1.1-build.40', 'Working-Memory-0.1.1-build.40-win-x64.exe');
    expect(readFileSync(installer)).toEqual(PAYLOAD);

    await updater.install();
    expect(spawned).toEqual([{ file: installer, args: ['/S', '--updated', '--force-run'] }]);
    expect(quit.count).toBe(1);
  });

  it('discards downloads that fail checksum verification', async () => {
    const { updater, spawned, root } = harness({ platform: 'win32', payload: Buffer.from('tampered bytes!') });
    await updater.check();
    const state = await updater.download();
    expect(state.phase).toBe('error');
    expect(state.error).toMatch(/checksum verification/);
    expect(existsSync(join(root, 'downloads', '0.1.1-build.40', 'Working-Memory-0.1.1-build.40-win-x64.exe'))).toBe(false);
    await expect(updater.install()).rejects.toThrow(/Download the update/);
    expect(spawned).toEqual([]);
  });

  it('stages and verifies the macOS bundle beside the installed app, then swaps it after quitting', async () => {
    const { updater, commands, spawned, quit, root } = harness({ platform: 'darwin' });
    await updater.check();
    expect((await updater.download()).phase).toBe('ready');
    const applications = join(root, 'Applications');
    const staged = join(applications, '.Working Memory.app.update');
    expect(commands.map((command) => command.file)).toEqual([
      '/usr/bin/hdiutil',
      '/usr/bin/ditto',
      '/usr/bin/hdiutil',
      '/usr/bin/plutil',
      '/usr/bin/codesign',
    ]);
    expect(commands[1].args[1]).toBe(staged);
    expect(commands[4].args).toEqual(['--verify', '--deep', '--strict', staged]);

    await updater.install();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].file).toBe('/bin/sh');
    expect(spawned[0].args.slice(-3)).toEqual(['4242', join(applications, 'Working Memory.app'), staged]);
    expect(quit.count).toBe(1);
  });

  it('refuses a macOS bundle with a different identifier', async () => {
    const { updater, root } = harness({ platform: 'darwin', bundleIdentifier: 'com.example.other' });
    await updater.check();
    const state = await updater.download();
    expect(state.phase).toBe('error');
    expect(state.error).toMatch(/not Working Memory/);
    expect(existsSync(join(root, 'Applications', '.Working Memory.app.update'))).toBe(false);
  });

  it('reports unsupported platforms and persists channel changes', async () => {
    const linux = harness({ platform: 'linux', arch: 'x64' });
    expect(linux.updater.state.supported).toBe(false);

    const { updater, saved } = harness({ platform: 'win32', channel: 'off' });
    expect((await updater.check()).phase).toBe('idle');
    const state = await updater.setChannel('stable');
    expect(saved).toEqual(['stable']);
    expect(state.channel).toBe('stable');
  });
});
