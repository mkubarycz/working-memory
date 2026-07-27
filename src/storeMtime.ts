import { statSync } from 'node:fs';

/**
 * Return the greatest `mtimeMs` across the given files, ignoring any that
 * cannot be stat'd (e.g. ENOENT when a file doesn't exist yet). Returns 0 when
 * none of the files can be stat'd.
 *
 * Used by the panel auto-refresh backstop (feature:panel-auto-refresh): the
 * control-plane daemon writes its SQLite store out-of-process, so polling the
 * store's mtime is a reliable fallback for the best-effort FileSystemWatcher.
 * In WAL mode writes land in `-wal` while the main db file only changes on
 * checkpoint, so callers pass both and take the newest.
 *
 * Pure aside from the injected `stat` fn, which defaults to `node:fs.statSync`
 * so tests can supply a fake without touching the filesystem.
 */
export function maxMtimeMs(
  paths: readonly string[],
  stat: (p: string) => { mtimeMs: number } = statSync,
): number {
  let max = 0;
  for (const p of paths) {
    try {
      const { mtimeMs } = stat(p);
      if (mtimeMs > max) {
        max = mtimeMs;
      }
    } catch {
      // Missing or unreadable file — ignore it and keep scanning the rest.
    }
  }
  return max;
}
