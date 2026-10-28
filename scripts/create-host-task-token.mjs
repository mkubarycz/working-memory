import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const filename = process.argv[2];
if (!filename || process.argv.length !== 3 || process.platform === 'win32') {
  console.error('Usage (macOS/Linux): node scripts/create-host-task-token.mjs /private/path/broker.secret');
  process.exitCode = 1;
} else {
  const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(`${randomBytes(32).toString('hex')}\n`);
    await file.sync();
    console.log('Private broker token created (mode 0600). Its value was not printed. Existing files are never overwritten.');
  } finally { await file.close(); }
}
