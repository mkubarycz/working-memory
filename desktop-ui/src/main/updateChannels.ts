import { readFile, writeFile } from 'node:fs/promises';
import type { BackendUpdateTarget, UpdateChannel } from '../shared/contracts';

export type { BackendUpdateTarget, UpdateChannel };

export const UPDATE_CHANNELS: readonly UpdateChannel[] = ['off', 'canary', 'stable'];
export const DEFAULT_RELEASES_URL = 'https://github.com/mkubarycz/working-memory/releases';
export const BACKEND_IMAGE_REPOSITORY = 'ghcr.io/mkubarycz/working-memory-control-plane';
export const UPDATE_MANIFEST_FILE = 'update.json';
export const CANARY_RELEASE_TAG = 'canary';

export const DESKTOP_PLATFORM_KEYS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'win32-arm64'] as const;
export type DesktopPlatformKey = typeof DESKTOP_PLATFORM_KEYS[number];

function isDesktopPlatformKey(value: string): value is DesktopPlatformKey {
  return (DESKTOP_PLATFORM_KEYS as readonly string[]).includes(value);
}

export interface UpdateAsset {
  file: string;
  sha256: string;
  size: number;
}

/** The `update.json` asset CI attaches to every canary and stable release. */
export interface UpdateManifest {
  channel: Exclude<UpdateChannel, 'off'>;
  version: string;
  tag: string;
  commit: string | null;
  publishedAt: string | null;
  desktop: Partial<Record<DesktopPlatformKey, UpdateAsset>>;
  backend: BackendUpdateTarget | null;
}

export interface UpdateSettings {
  desktopChannel: UpdateChannel;
  backendChannel: UpdateChannel;
}

export function isUpdateChannel(value: unknown): value is UpdateChannel {
  return typeof value === 'string' && (UPDATE_CHANNELS as readonly string[]).includes(value);
}

export function releasesUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.WM_UPDATE_RELEASES_URL?.trim();
  if (override && /^https?:\/\//.test(override)) return override.replace(/\/+$/, '');
  return DEFAULT_RELEASES_URL;
}

/** Canary is one rolling prerelease; Stable resolves through GitHub's latest full release. */
export function manifestUrl(channel: Exclude<UpdateChannel, 'off'>, base = DEFAULT_RELEASES_URL): string {
  return channel === 'canary'
    ? `${base}/download/${CANARY_RELEASE_TAG}/${UPDATE_MANIFEST_FILE}`
    : `${base}/latest/download/${UPDATE_MANIFEST_FILE}`;
}

export function assetUrl(manifest: UpdateManifest, asset: UpdateAsset, base = DEFAULT_RELEASES_URL): string {
  return `${base}/download/${encodeURIComponent(manifest.tag)}/${encodeURIComponent(asset.file)}`;
}

export function desktopPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): DesktopPlatformKey | null {
  const key = `${platform}-${arch}`;
  return isDesktopPlatformKey(key) ? key : null;
}

/**
 * Installer builds name themselves `<base>-build.<run>` for canary and plain semver for
 * stable tags; local builds are marked so they never replace themselves with a download.
 */
export function defaultDesktopChannel(version: string, localBuild: boolean): UpdateChannel {
  if (localBuild) return 'off';
  return /-build\.\d+$/.test(version) ? 'canary' : 'stable';
}

const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const FILE = /^[0-9A-Za-z][0-9A-Za-z._ -]{0,199}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseAsset(value: unknown): UpdateAsset | null {
  if (!value || typeof value !== 'object') return null;
  const { file, sha256, size } = value as Record<string, unknown>;
  if (typeof file !== 'string' || !FILE.test(file) || file.includes('..')) return null;
  if (typeof sha256 !== 'string' || !SHA256.test(sha256.toLowerCase())) return null;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null;
  return { file, sha256: sha256.toLowerCase(), size };
}

/** Only images from this project's GHCR repository are accepted as backend updates. */
export function parseBackendImage(image: unknown): BackendUpdateTarget | null {
  if (typeof image !== 'string' || !image.startsWith(`${BACKEND_IMAGE_REPOSITORY}:`)) return null;
  const version = image.slice(BACKEND_IMAGE_REPOSITORY.length + 1);
  return VERSION.test(version) ? { version, image } : null;
}

export function parseUpdateManifest(raw: unknown, expectedChannel: Exclude<UpdateChannel, 'off'>): UpdateManifest {
  const value = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  if (!value || typeof value !== 'object') throw new Error('The update manifest is not an object.');
  const record = value as Record<string, unknown>;
  if (record.channel !== expectedChannel) {
    throw new Error(`The ${expectedChannel} update manifest reports channel "${String(record.channel)}".`);
  }
  if (typeof record.version !== 'string' || !VERSION.test(record.version)) {
    throw new Error('The update manifest has an invalid version.');
  }
  if (typeof record.tag !== 'string' || !VERSION.test(record.tag)) {
    throw new Error('The update manifest has an invalid release tag.');
  }
  const desktop: UpdateManifest['desktop'] = {};
  if (record.desktop && typeof record.desktop === 'object') {
    for (const [key, asset] of Object.entries(record.desktop as Record<string, unknown>)) {
      const parsed = parseAsset(asset);
      if (parsed && isDesktopPlatformKey(key)) desktop[key] = parsed;
    }
  }
  const backendRecord = record.backend as Record<string, unknown> | null | undefined;
  return {
    channel: expectedChannel,
    version: record.version,
    tag: record.tag,
    commit: stringOrNull(record.commit),
    publishedAt: stringOrNull(record.publishedAt),
    desktop,
    backend: backendRecord ? parseBackendImage(backendRecord.image) : null,
  };
}

export type ManifestFetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Returns null when the channel has not published an update manifest yet. */
export async function fetchUpdateManifest(
  channel: Exclude<UpdateChannel, 'off'>,
  options: { fetch?: ManifestFetch; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<UpdateManifest | null> {
  const request = options.fetch ?? fetch;
  const url = manifestUrl(channel, releasesUrl(options.env));
  const response = await request(url, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Unable to check for ${channel} updates (HTTP ${response.status}).`);
  return parseUpdateManifest(await response.text(), channel);
}

export async function readUpdateSettings(file: string, defaults: UpdateSettings): Promise<UpdateSettings> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<UpdateSettings>;
    return {
      desktopChannel: isUpdateChannel(parsed.desktopChannel) ? parsed.desktopChannel : defaults.desktopChannel,
      backendChannel: isUpdateChannel(parsed.backendChannel) ? parsed.backendChannel : defaults.backendChannel,
    };
  } catch {
    return { ...defaults };
  }
}

export async function writeUpdateSettings(file: string, settings: UpdateSettings): Promise<void> {
  await writeFile(file, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
