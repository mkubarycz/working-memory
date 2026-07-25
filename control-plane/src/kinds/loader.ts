/**
 * Kind loader — discovers `*.kind.ts` / `*.kind.js` files in the kinds folder
 * and registers each descriptor. Adding a kind = dropping ONE `*.kind.ts` file
 * into this folder; there is no central list to edit.
 *
 * Discovery is a runtime directory scan of `dir` (default: this module's own
 * folder). It works under BOTH runtimes because we resolve every file through a
 * dynamic `import()` (which `tsc --module node16` preserves rather than
 * downleveling to `require`):
 *   - Compiled CJS daemon: `__dirname` is `out/control-plane/kinds`, which holds
 *     the compiled `*.kind.js` files. `import()` loads them as CJS.
 *   - Vitest: `__dirname` is `control-plane/src/kinds`, which holds the source
 *     `*.kind.ts` files. Vitest's transform pipeline handles the `import()`.
 * `resolveEntry` normalizes the differing CJS/ESM module shapes so both yield
 * the same `{ name, descriptor }`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerKind } from './registry.js';
import type { KindModule } from './base.js';

const KIND_FILE_RE = /\.kind\.(js|ts)$/;

/** Unwrap the CJS/ESM interop shapes down to the `{ name, descriptor }` entry. */
function resolveEntry(mod: unknown, file: string): KindModule {
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
  throw new Error(`kind file "${file}" must default-export { name, descriptor }`);
}

/**
 * Discover and register every kind file in `dir`. Returns the registered names.
 * Missing directories yield `[]` (never throws on a bad path).
 */
export async function loadKinds(dir: string = __dirname): Promise<string[]> {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  // One extension per environment in practice; dedupe by base name (prefer .js)
  // to stay safe if both ever coexist in a directory.
  const byBase = new Map<string, string>();
  for (const file of names) {
    if (!KIND_FILE_RE.test(file) || file.endsWith('.d.ts')) {
      continue;
    }
    const base = file.replace(KIND_FILE_RE, '');
    const existing = byBase.get(base);
    if (!existing || (existing.endsWith('.ts') && file.endsWith('.js'))) {
      byBase.set(base, file);
    }
  }

  const registered: string[] = [];
  for (const file of byBase.values()) {
    const full = path.join(dir, file);
    const mod = (await import(pathToFileURL(full).href)) as unknown;
    const entry = resolveEntry(mod, file);
    registerKind(entry.name, entry.descriptor);
    registered.push(entry.name);
  }
  return registered;
}
