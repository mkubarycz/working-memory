import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const originalUserData = app.getPath('userData');
app.setName('Working Memory');
app.setPath('userData', originalUserData);
let stopping = false;

function recordFailure(context: string, error: unknown): void {
  console.error(`[desktop] ${context}:`, error);
  try {
    const directory = app.getPath('logs');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    writeFileSync(join(directory, 'main-process-error.log'),
      `${new Date().toISOString()} ${context}\n${detail.slice(0, 65536)}\n`, { mode: 0o600 });
  } catch (loggingError) {
    console.error('[desktop] Unable to write main process error log:', loggingError);
  }
}

function stopAfterFailure(context: string, error: unknown): void {
  if (stopping) return;
  stopping = true;
  recordFailure(context, error);
  app.exit(1);
}

process.on('uncaughtException', error => stopAfterFailure('Uncaught main process exception', error));
process.on('unhandledRejection', error => {
  if (!stopping) recordFailure('Unhandled main process rejection', error);
});

try {
  // Load pre-ready protocol registrations before Electron emits ready.
  const application = await import('./index');
  void application.desktopStartup.catch(error => stopAfterFailure('Desktop startup failed', error));
} catch (error) {
  stopAfterFailure('Desktop startup failed', error);
}
