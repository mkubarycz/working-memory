import { expect, it } from 'vitest';
import { build } from 'vite';
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);

it.skipIf(process.platform !== 'darwin')('opens a desktop from a normal macOS launch while its background process stays running', async () => {
  const executable: unknown = createRequire(import.meta.url)('electron');
  if (typeof executable !== 'string') throw new Error('Electron executable is unavailable.');
  const directory = await mkdtemp(join(tmpdir(), 'wm-headless-launch-'));
  const bundle = join(directory, 'WM Launch Test.app');
  const application = join(bundle, 'Contents', 'Resources', 'app');
  const serviceState = join(directory, 'service.json');
  const desktopState = join(directory, 'desktop.json');
  const activationState = join(directory, 'activation.json');
  let service: ReturnType<typeof spawn> | undefined;
  let desktopPid: number | undefined;
  let output = '';
  try {
    await cp(dirname(dirname(dirname(executable))), bundle, { recursive: true, verbatimSymlinks: true });
    await execute('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier com.workingmemory.launch-test.${process.pid}`, join(bundle, 'Contents', 'Info.plist')]);
    await build({
      configFile: false, logLevel: 'error',
      build: {
        ssr: fileURLToPath(new URL('../src/main/headlessDesktopActivation.ts', import.meta.url)),
        outDir: application, emptyOutDir: false,
        rollupOptions: { output: { format: 'cjs', entryFileNames: 'activation.cjs' } },
      },
    });
    await writeFile(join(application, 'package.json'), JSON.stringify({ name: 'wm-launch-test', version: '1.0.0', main: 'main.cjs' }));
    await writeFile(join(application, 'main.cjs'), `
      const {app, BrowserWindow} = require('electron');
      const {writeFileSync} = require('node:fs');
      const {launchDesktopApplication, registerHeadlessDesktopActivation} = require('./activation.cjs');
      app.setPath('userData', ${JSON.stringify(join(directory, 'profile'))});
      const background = process.argv.includes('--headless');
      process.once('SIGTERM', () => app.exit(0));
      if (background) {
        app.dock.hide();
        registerHeadlessDesktopActivation(app,
          url => {
            writeFileSync(${JSON.stringify(activationState)}, JSON.stringify({pid:process.pid}));
            return launchDesktopApplication(${JSON.stringify(bundle)}, app.getAppPath(), url);
          },
          error => { console.error(error); app.exit(1); });
      }
      app.whenReady().then(() => {
        if (background) writeFileSync(${JSON.stringify(serviceState)}, JSON.stringify({pid:process.pid}));
        else {
          new BrowserWindow({show:false});
          writeFileSync(${JSON.stringify(desktopState)}, JSON.stringify({pid:process.pid, windows:BrowserWindow.getAllWindows().length}));
        }
      }).catch(error => { console.error(error); app.exit(1); });
    `);
    await execute('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', bundle]);
    service = spawn(join(bundle, 'Contents', 'MacOS', 'Electron'), [application, '--headless'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    service.stdout?.on('data', data => { output = (output + data).slice(-8000); });
    service.stderr?.on('data', data => { output = (output + data).slice(-8000); });
    async function waitFor(file: string): Promise<void> {
      const deadline = Date.now() + 15000;
      while (!existsSync(file)) {
        if (service?.exitCode !== null || Date.now() >= deadline) throw new Error(`Launch did not produce ${file}: ${output}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    await waitFor(serviceState);
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(existsSync(desktopState)).toBe(false);
    expect(existsSync(activationState)).toBe(false);
    await execute('/usr/bin/open', ['-a', bundle]);
    await waitFor(activationState);
    await waitFor(desktopState);
    const desktop = JSON.parse(await readFile(desktopState, 'utf8'));
    desktopPid = desktop.pid;
    expect(desktop.windows).toBe(1);
    expect(desktopPid).not.toBe(service.pid);
    expect(service.exitCode).toBeNull();
    expect(JSON.parse(await readFile(activationState, 'utf8')).pid).toBe(service.pid);
    expect(JSON.parse(await readFile(serviceState, 'utf8')).pid).toBe(service.pid);
  } finally {
    if (!desktopPid && existsSync(desktopState)) desktopPid = JSON.parse(await readFile(desktopState, 'utf8')).pid;
    for (const pid of [desktopPid, service?.pid]) {
      if (!pid) continue;
      try { process.kill(pid, 'SIGTERM'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error; }
      const deadline = Date.now() + 5000;
      while (true) {
        try { process.kill(pid, 0); }
        catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break;
          throw error;
        }
        if (Date.now() >= deadline) throw new Error(`Test application ${pid} did not exit.`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
