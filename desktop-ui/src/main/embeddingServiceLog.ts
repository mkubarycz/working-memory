import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { embeddingErrorMessage } from '../../../control-plane/src/embeddingContract';

export function appendEmbeddingServiceLog(home: string, message: string): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, 'service.log'), `${new Date().toISOString()} ${embeddingErrorMessage(message)}\n`, { mode: 0o600 });
}

export function readEmbeddingServiceLog(home: string): { logPath: string; logExists: boolean; log: string } {
  const logPath = join(home, 'service.log');
  let file: number;
  try { file = openSync(logPath, 'r'); }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return { logPath, logExists: false, log: '' };
    }
    throw error;
  }
  try {
    const size = fstatSync(file).size;
    const offset = Math.max(0, size - 32768);
    const buffer = Buffer.alloc(Math.min(size, 32768));
    const bytes = readSync(file, buffer, 0, buffer.length, offset);
    let log = buffer.subarray(0, bytes).toString('utf8');
    if (offset) {
      const newline = log.indexOf('\n');
      log = newline < 0 ? '[Log line exceeds the diagnostic limit.]' : log.slice(newline + 1);
    }
    log = log.trimEnd().split('\n').slice(-100).map(line => line ? embeddingErrorMessage(line) : '').join('\n');
    return { logPath, logExists: true, log };
  } finally { closeSync(file); }
}
