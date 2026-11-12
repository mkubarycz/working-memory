import { expect, it } from 'vitest';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

it('routes npm start through the guarded package entry', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(manifest.main).toBe('out/main/bootstrap.js');
  expect(manifest.scripts.start).toBe('npm run build && electron .');
});

it('keeps the shared lock helpers importable in an ES-module desktop bundle', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wm-lock-esm-'));
  try {
    const entry = join(directory, 'entry.ts'), bundle = join(directory, 'entry.mjs');
    const source = fileURLToPath(new URL('../../control-plane/src/lockfile.ts', import.meta.url));
    await writeFile(entry, `import { LOCK_FILE, acquireOfflineMaintenanceLock } from ${JSON.stringify(source)};
      const lock = acquireOfflineMaintenanceLock(process.argv[2]);
      lock.release();
      console.log(LOCK_FILE);`);
    await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm' });
    const result = spawnSync(process.execPath, [bundle, join(directory, 'journal.sqlite')], { encoding: 'utf8', timeout: 10000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('control-plane.lock');
    expect(existsSync(join(directory, 'run', 'offline-maintenance.lock'))).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const cases: Array<{ name: string; source: string; context: string; status: number; loggingFailure?: boolean }> = [
  {
    name: 'module evaluation failure',
    source: 'throw new ReferenceError("require is not defined in ES module scope"); export const desktopStartup = Promise.resolve();',
    context: 'Desktop startup failed', status: 1,
  },
  {
    name: 'asynchronous startup failure',
    source: 'export const desktopStartup = Promise.reject(new Error("Startup initialization failed"));',
    context: 'Desktop startup failed', status: 1,
  },
  {
    name: 'uncaught runtime exception',
    source: 'export const desktopStartup = Promise.resolve(); setTimeout(() => { throw new Error("Unhandled callback"); }, 25);',
    context: 'Uncaught main process exception', status: 1,
  },
  {
    name: 'unhandled runtime rejection',
    source: `import { app } from 'electron'; export const desktopStartup = Promise.resolve();
      setTimeout(() => { void Promise.reject(new Error("Unhandled work")); }, 25);
      setTimeout(() => app.exit(0), 150);`,
    context: 'Unhandled main process rejection', status: 0,
  },
  {
    name: 'unwritable error log',
    source: 'throw new Error("Startup initialization failed"); export const desktopStartup = Promise.resolve();',
    context: 'Desktop startup failed', status: 1, loggingFailure: true,
  },
];

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY).each(cases)(
  'handles $name without Electron raw error popups',
  async fixture => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'wm-bootstrap-'));
    try {
      const logs = join(directory, 'logs'), application = join(directory, 'fixture.ts');
      await mkdir(logs);
      await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
      await writeFile(application, `import { app as storageApp } from 'electron';
        if (storageApp.getPath('userData') !== ${JSON.stringify(join(directory, 'profile'))})
          throw new Error('Bootstrap changed the original profile directory');
        ${fixture.source}`);
      await writeFile(join(directory, 'blocked'), 'not a directory');
      await build({
        entryPoints: [fileURLToPath(new URL('../src/main/bootstrap.ts', import.meta.url))],
        outdir: directory, bundle: true, platform: 'node', format: 'esm', splitting: true, external: ['electron'],
        plugins: [{
          name: 'startup-fixture',
          setup(builder) {
            builder.onResolve({ filter: /^\.\/index$/ }, () => ({ path: application }));
          },
        }],
      });
      const popup = join(directory, 'unexpected-popup');
      const launcher = join(directory, 'launch.cjs');
      await writeFile(launcher, `
        const { app, dialog } = require('electron');
        const { writeFileSync } = require('node:fs');
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.setPath('logs', ${JSON.stringify(logs)});
        ${fixture.loggingFailure ? `const getPath = app.getPath.bind(app);
          app.getPath = name => name === 'logs' ? ${JSON.stringify(join(directory, 'blocked', 'logs'))} : getPath(name);` : ''}
        dialog.showErrorBox = () => { writeFileSync(${JSON.stringify(popup)}, 'unexpected'); app.exit(97); };
        void import('./bootstrap.js');
      `);
      const result = spawnSync(executable, [launcher], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, encoding: 'utf8', timeout: 10000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(fixture.status);
      expect(existsSync(popup)).toBe(false);
      expect(result.stderr).toContain(fixture.context);
      expect(result.stderr).not.toContain('Bootstrap changed the original profile directory');
      if (fixture.loggingFailure) {
        expect(result.stderr).toContain('Unable to write main process error log');
      } else {
        const path = join(logs, 'main-process-error.log');
        expect(readFileSync(path, 'utf8')).toContain(fixture.context);
        if (process.platform !== 'win32') expect(statSync(path).mode & 0o077).toBe(0);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20000,
);
