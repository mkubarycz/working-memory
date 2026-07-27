/**
 * Kind loader — discovers per-kind SUBFOLDERS in the kinds folder and registers
 * each descriptor. Adding a kind = dropping ONE `<kind>/index.ts` folder into
 * this directory; there is no central list to edit.
 *
 * Discovery is a runtime scan of `dir` (default: this module's own folder). For
 * each SUBDIRECTORY it resolves the entry module `<subdir>/index.js` (compiled
 * daemon) or `<subdir>/index.ts` (vitest), preferring `.js` when both exist. It
 * works under BOTH runtimes because we resolve every entry through a dynamic
 * `import()` (which `tsc --module node16` preserves rather than downleveling to
 * `require`):
 *   - Compiled CJS daemon: `__dirname` is `out/control-plane/kinds`, whose
 *     subfolders hold the compiled `<kind>/index.js`. `import()` loads them as CJS.
 *   - Vitest: `__dirname` is `control-plane/src/kinds`, whose subfolders hold the
 *     source `<kind>/index.ts`. Vitest's transform pipeline handles the `import()`.
 * `resolveEntry` normalizes the differing CJS/ESM module shapes so both yield the
 * same `{ name, descriptor }`. Sibling files at the kinds root (base.ts,
 * loader.ts, registry.ts) are NOT directories, so they are skipped; a subfolder
 * with no `index` file is skipped too (never throws).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerKind } from './registry.js';
import type { KindModule } from './base.js';

/** Unwrap the CJS/ESM interop shapes down to the `{ name, descriptor }` entry. */
function resolveEntry(mod: unknown, source: string): KindModule {
  const m = mod as Record<string, unknown>;
  const candidates: unknown[] = [
    m?.default,
    m,
    (m?.default as Record<string, unknown> | undefined)?.default,
  ];
  for (const c of candidates) {
    const entry = c as Partial<KindModule> | undefined;
    if (entry && typeof entry.name === 'string' && entry.descriptor) {
      return entry as KindModule;
    }
  }
  throw new Error(`kind module "${source}" must default-export { name, descriptor }`);
}

/**
 * Resolve a kind subfolder's entry module: `<subdir>/index.js` preferred (so a
 * compiled build wins over stray sources), else `<subdir>/index.ts`. Returns
 * `null` when the subfolder has no `index` file, so the caller can skip it
 * rather than throw.
 */
function resolveIndex(subdir: string): string | null {
  const js = path.join(subdir, 'index.js');
  if (fs.existsSync(js)) {
    return js;
  }
  const ts = path.join(subdir, 'index.ts');
  if (fs.existsSync(ts)) {
    return ts;
  }
  return null;
}

/**
 * Discover and register every kind subfolder in `dir`. Returns the registered
 * names. Missing directories yield `[]` (never throws on a bad path).
 */
export async function loadKinds(dir: string = __dirname): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const registered: string[] = [];
  for (const entry of entries) {
    // Only per-kind SUBFOLDERS are kinds; base.ts / loader.ts / registry.ts at
    // the root are files and are skipped.
    if (!entry.isDirectory()) {
      continue;
    }
    const index = resolveIndex(path.join(dir, entry.name));
    if (!index) {
      // A subfolder without an `index` entry module is not a kind — skip it.
      continue;
    }
    const mod = (await import(pathToFileURL(index).href)) as unknown;
    const kind = resolveEntry(mod, entry.name);
    registerKind(kind.name, kind.descriptor, kind.registerApi);
    registered.push(kind.name);
  }
  return registered;
}

