import { randomBytes } from 'node:crypto';
import { constants, openSync, writeFileSync, closeSync } from 'node:fs';
import { loadHostTaskAdminCredential } from './hostTasks.js';

export function ensureInstanceBootstrap(filename: string): string {
  let fd: number;
  try { fd = openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const existing = loadHostTaskAdminCredential({ WM_HOST_TASK_ADMIN_TOKEN_FILE: filename });
    if (!existing) throw new Error('Instance owner setup is unavailable.');
    return existing;
  }
  try { writeFileSync(fd, randomBytes(32).toString('base64url'), 'utf8'); }
  finally { closeSync(fd); }
  const token = loadHostTaskAdminCredential({ WM_HOST_TASK_ADMIN_TOKEN_FILE: filename });
  if (!token) throw new Error('Instance owner setup is unavailable.');
  return token;
}
