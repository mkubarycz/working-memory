import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, constants, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { ExecFileCommandRunner, type CommandRunner } from './dockerContainerService';
import {
  assetUrl,
  desktopPlatformKey,
  fetchUpdateManifest,
  releasesUrl,
  type ManifestFetch,
  type UpdateAsset,
  type UpdateChannel,
  type UpdateManifest,
} from './updateChannels';
import type { DesktopUpdateState } from '../shared/contracts';

export const MAC_BUNDLE_IDENTIFIER = 'com.kubarycz.working-memory';
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
const FIRST_CHECK_DELAY_MS = 15_000;

/** Replaces the app bundle once the running app exits, restoring the old bundle on failure. */
export const MAC_SWAP_SCRIPT = [
  'pid="$1"; app="$2"; staged="$3"; previous="$app.previous"',
  'i=0; while kill -0 "$pid" 2>/dev/null; do sleep 0.2; i=$((i+1)); [ "$i" -gt 300 ] && exit 1; done',
  'rm -rf "$previous"',
  'if mv "$app" "$previous"; then',
  '  if mv "$staged" "$app"; then rm -rf "$previous"; else mv "$previous" "$app"; fi',
  'fi',
  'open "$app"',
].join('\n');

export interface DesktopUpdaterOptions {
  currentVersion: string;
  channel: UpdateChannel;
  saveChannel: (channel: UpdateChannel) => Promise<void>;
  /** Writable directory for downloaded installers. */
  downloadDirectory: string;
  /** The running app's executable (process.execPath). */
  executablePath: string;
  pid?: number;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: ManifestFetch;
  runner?: CommandRunner;
  spawnDetached?: (file: string, args: string[]) => void;
  quit: () => void;
  onState?: (state: DesktopUpdateState) => void;
  now?: () => Date;
}

interface PreparedUpdate {
  manifest: UpdateManifest;
  /** Downloaded installer (Windows) or staged app bundle (macOS). */
  path: string;
}

function defaultSpawnDetached(file: string, args: string[]): void {
  const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => console.error('[updates] Unable to start the update installer:', error));
  child.unref();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The `.app` bundle containing the running executable, or null outside a bundle. */
export function macAppBundle(executablePath: string): string | null {
  const bundle = dirname(dirname(dirname(executablePath)));
  return bundle.endsWith('.app') && basename(dirname(executablePath)) === 'MacOS' ? bundle : null;
}

/**
 * Self-updates installer builds from the project's GitHub Releases. The macOS path swaps the
 * app bundle itself because Squirrel.Mac requires a paid Developer ID signature; Windows runs
 * the downloaded NSIS installer silently and relaunches.
 */
export class DesktopUpdater {
  private current: DesktopUpdateState;
  private manifest: UpdateManifest | null = null;
  private prepared: PreparedUpdate | null = null;
  private operation: Promise<unknown> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetch: ManifestFetch;
  private readonly runner: CommandRunner;
  private readonly spawnDetached: (file: string, args: string[]) => void;
  private readonly now: () => Date;

  constructor(private readonly options: DesktopUpdaterOptions) {
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.env = options.env ?? process.env;
    this.fetch = options.fetch ?? fetch;
    this.runner = options.runner ?? new ExecFileCommandRunner();
    this.spawnDetached = options.spawnDetached ?? defaultSpawnDetached;
    this.now = options.now ?? (() => new Date());
    const unsupportedReason = this.unsupportedReason();
    this.current = {
      supported: unsupportedReason === null,
      unsupportedReason,
      currentVersion: options.currentVersion,
      channel: options.channel,
      phase: 'idle',
      available: null,
      progress: null,
      error: null,
      checkedAt: null,
    };
  }

  get state(): DesktopUpdateState {
    return { ...this.current, available: this.current.available ? { ...this.current.available } : null };
  }

  /** Checks shortly after launch and then every six hours while a channel is selected. */
  startSchedule(): void {
    this.stopSchedule();
    const tick = () => {
      if (this.current.channel !== 'off' && this.current.supported && !this.operation && this.current.phase !== 'ready') {
        void this.check().catch(() => undefined);
      }
    };
    this.timers.push(setTimeout(tick, FIRST_CHECK_DELAY_MS));
    this.timers.push(setInterval(tick, CHECK_INTERVAL_MS));
    for (const timer of this.timers) timer.unref?.();
  }

  stopSchedule(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  async setChannel(channel: UpdateChannel): Promise<DesktopUpdateState> {
    if (this.operation) throw new Error('Wait for the current update operation to finish.');
    await this.options.saveChannel(channel);
    this.manifest = null;
    await this.discardPrepared();
    this.update({ channel, phase: 'idle', available: null, progress: null, error: null });
    if (channel !== 'off' && this.current.supported) await this.check().catch(() => undefined);
    return this.state;
  }

  check(): Promise<DesktopUpdateState> {
    return this.exclusive(async () => {
      const channel = this.current.channel;
      if (channel === 'off') {
        this.update({ phase: 'idle', available: null, error: null });
        return this.state;
      }
      this.requireSupported();
      this.update({ phase: 'checking', error: null });
      try {
        const manifest = await fetchUpdateManifest(channel, { fetch: this.fetch, env: this.env });
        const checkedAt = this.now().toISOString();
        const asset = manifest ? this.assetFor(manifest) : null;
        if (!manifest || !asset || manifest.version === this.options.currentVersion) {
          this.manifest = null;
          this.update({ phase: 'up-to-date', available: null, checkedAt });
          return this.state;
        }
        if (this.prepared?.manifest.version === manifest.version && this.current.phase === 'ready') return this.state;
        this.manifest = manifest;
        await this.discardPrepared();
        this.update({
          phase: 'available',
          checkedAt,
          available: {
            version: manifest.version,
            publishedAt: manifest.publishedAt,
            releaseUrl: `${releasesUrl(this.env)}/tag/${encodeURIComponent(manifest.tag)}`,
          },
        });
      } catch (error) {
        this.update({ phase: 'error', error: message(error) });
      }
      return this.state;
    });
  }

  download(): Promise<DesktopUpdateState> {
    return this.exclusive(async () => {
      this.requireSupported();
      const manifest = this.manifest;
      const asset = manifest ? this.assetFor(manifest) : null;
      if (!manifest || !asset) throw new Error('Check for updates before downloading.');
      this.update({ phase: 'downloading', progress: 0, error: null });
      try {
        const directory = join(this.options.downloadDirectory, manifest.version);
        await rm(directory, { recursive: true, force: true });
        await mkdir(directory, { recursive: true });
        const file = join(directory, asset.file);
        await this.downloadAsset(assetUrl(manifest, asset, releasesUrl(this.env)), asset, file);
        const path = this.platform === 'darwin' ? await this.stageMacBundle(file, directory) : file;
        this.prepared = { manifest, path };
        this.update({ phase: 'ready', progress: 1 });
      } catch (error) {
        this.update({ phase: 'error', progress: null, error: message(error) });
      }
      return this.state;
    });
  }

  async install(): Promise<void> {
    const prepared = this.prepared;
    if (!prepared || this.current.phase !== 'ready') throw new Error('Download the update before installing it.');
    this.update({ phase: 'installing' });
    if (this.platform === 'darwin') {
      const bundle = macAppBundle(this.options.executablePath)!;
      this.spawnDetached('/bin/sh', ['-c', MAC_SWAP_SCRIPT, 'working-memory-update', String(this.options.pid ?? process.pid), bundle, prepared.path]);
    } else {
      // --updated keeps existing shortcuts; --force-run relaunches after the silent install.
      this.spawnDetached(prepared.path, ['/S', '--updated', '--force-run']);
    }
    this.options.quit();
  }

  private unsupportedReason(): string | null {
    const key = desktopPlatformKey(this.platform, this.arch);
    if (!key || (this.platform !== 'darwin' && this.platform !== 'win32')) {
      return 'Automatic updates are available for macOS and Windows installer builds.';
    }
    if (this.platform === 'darwin' && !macAppBundle(this.options.executablePath)) {
      return 'Automatic updates need the installed Working Memory.app.';
    }
    return null;
  }

  private requireSupported(): void {
    if (!this.current.supported) throw new Error(this.current.unsupportedReason ?? 'Automatic updates are unavailable.');
  }

  private assetFor(manifest: UpdateManifest): UpdateAsset | null {
    const key = desktopPlatformKey(this.platform, this.arch);
    return key ? manifest.desktop[key] ?? null : null;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operation) throw new Error('An update operation is already running.');
    const running = operation();
    this.operation = running;
    try {
      return await running;
    } finally {
      this.operation = null;
    }
  }

  private update(patch: Partial<DesktopUpdateState>): void {
    this.current = { ...this.current, ...patch };
    this.options.onState?.(this.state);
  }

  private async downloadAsset(url: string, asset: UpdateAsset, destination: string): Promise<void> {
    const response = await this.fetch(url, { cache: 'no-store' });
    if (!response.ok || !response.body) throw new Error(`Unable to download ${asset.file} (HTTP ${response.status}).`);
    const partial = `${destination}.partial`;
    const hash = createHash('sha256');
    const output = createWriteStream(partial, { mode: 0o700 });
    let received = 0;
    let reported = 0;
    try {
      for await (const chunk of Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)) {
        const bytes = chunk as Buffer;
        received += bytes.length;
        if (received > asset.size) throw new Error(`${asset.file} is larger than the release manifest declares.`);
        hash.update(bytes);
        if (!output.write(bytes)) await once(output, 'drain');
        const progress = Math.floor((received / asset.size) * 100) / 100;
        if (progress > reported) {
          reported = progress;
          this.update({ progress });
        }
      }
      output.end();
      await once(output, 'finish');
    } catch (error) {
      output.destroy();
      await rm(partial, { force: true });
      throw error;
    }
    const digest = hash.digest('hex');
    if (received !== asset.size || digest !== asset.sha256) {
      await rm(partial, { force: true });
      throw new Error(`${asset.file} failed checksum verification; the download was discarded.`);
    }
    await rename(partial, destination);
  }

  /** Copies the app out of the verified DMG next to the installed bundle and validates it. */
  private async stageMacBundle(dmg: string, directory: string): Promise<string> {
    const bundle = macAppBundle(this.options.executablePath)!;
    const parent = dirname(bundle);
    try {
      await access(parent, constants.W_OK);
    } catch {
      throw new Error(`Working Memory cannot replace itself in ${parent}. Move Working Memory.app to a folder you can write to.`);
    }
    const mountPoint = await mkdtemp(join(directory, 'mount-'));
    const staged = join(parent, `.${basename(bundle)}.update`);
    await rm(staged, { recursive: true, force: true });
    await this.runner.run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mountPoint, dmg], { timeoutMs: 120_000 });
    try {
      await this.runner.run('/usr/bin/ditto', [join(mountPoint, 'Working Memory.app'), staged], { timeoutMs: 300_000 });
    } finally {
      await this.runner.run('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], { timeoutMs: 60_000 }).catch(() => undefined);
    }
    try {
      const { stdout } = await this.runner.run(
        '/usr/bin/plutil',
        ['-extract', 'CFBundleIdentifier', 'raw', join(staged, 'Contents', 'Info.plist')],
        { timeoutMs: 15_000 },
      );
      if (stdout.trim() !== MAC_BUNDLE_IDENTIFIER) throw new Error('The downloaded app is not Working Memory.');
      await this.runner.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged], { timeoutMs: 120_000 });
    } catch (error) {
      await rm(staged, { recursive: true, force: true });
      throw new Error(`The downloaded app failed verification: ${message(error)}`);
    }
    await rm(dmg, { force: true });
    return staged;
  }

  private async discardPrepared(): Promise<void> {
    const prepared = this.prepared;
    this.prepared = null;
    if (prepared && this.platform === 'darwin') await rm(prepared.path, { recursive: true, force: true });
  }
}
