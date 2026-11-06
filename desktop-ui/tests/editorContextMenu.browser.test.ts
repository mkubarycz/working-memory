import { expect, it } from 'vitest';
import { transformWithEsbuild } from 'vite';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.skipIf(process.platform === 'linux' && !process.env.DISPLAY)(
  'cleans up dictionary monitoring when real Electron windows are destroyed without affecting other windows',
  async () => {
    const executable: unknown = createRequire(import.meta.url)('electron');
    if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-dictionary-browser-'));
    try {
      const source = await readFile(new URL('../src/main/editorContextMenu.ts', import.meta.url), 'utf8');
      const compiled = await transformWithEsbuild(source, 'editorContextMenu.ts', { format: 'cjs' });
      const module = join(directory, 'editorContextMenu.cjs');
      await writeFile(module, compiled.code);
      const script = join(directory, 'dictionary-test.cjs');
      await writeFile(script, `
        const { app, BrowserWindow } = require('electron');
        const assert = require('node:assert/strict');
        const { once } = require('node:events');
        const { watchSpellingDictionaryFailures } = require(${JSON.stringify(module)});
        app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
        app.on('window-all-closed', () => {});
        process.on('uncaughtException', error => { console.error(error); app.exit(1); });
        app.whenReady().then(async () => {
          const first = new BrowserWindow({ show: false });
          const second = new BrowserWindow({ show: false });
          const session = first.webContents.session;
          assert.equal(second.webContents.session, session);
          const event = 'spellcheck-dictionary-download-failure';
          const baseline = session.listenerCount(event);
          const reports = [];
          watchSpellingDictionaryFailures(first.webContents, language => reports.push('first:' + language));
          watchSpellingDictionaryFailures(second.webContents, language => reports.push('second:' + language));
          assert.equal(session.listenerCount(event), baseline + 2);
          const firstDestroyed = once(first.webContents, 'destroyed');
          first.destroy();
          await firstDestroyed;
          assert.equal(session.listenerCount(event), baseline + 1);
          session.emit(event, {}, 'en-US');
          assert.deepEqual(reports, ['second:en-US']);
          const secondDestroyed = once(second.webContents, 'destroyed');
          second.destroy();
          await secondDestroyed;
          assert.equal(session.listenerCount(event), baseline);
          console.log('dictionary-browser: native window cleanup passed');
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `);
      const { stdout } = await promisify(execFile)(executable, [script], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
        timeout: 20_000,
      });
      expect(stdout).toContain('dictionary-browser: native window cleanup passed');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
