import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function findLatestVsix(rootDir: string): string | null {
  const stack = [rootDir];
  const candidates: string[] = [];

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) {
      continue;
    }
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.vsix')) {
        candidates.push(fullPath);
      }
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  const byMtime = candidates.map((path) => ({
    path,
    mtimeMs: statSync(path).mtimeMs,
  }));

  byMtime.sort((a, b) => {
    const mtimeDiff = b.mtimeMs - a.mtimeMs;
    return mtimeDiff !== 0 ? mtimeDiff : a.path.localeCompare(b.path);
  });
  return byMtime[0].path;
}
