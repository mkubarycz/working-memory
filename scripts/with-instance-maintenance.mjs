import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { maintenancePath, maintenanceRecordSchema, MAX_MAINTENANCE_MS } from '../desktop-ui/src/main/instanceMaintenance.ts';

const separator = process.argv.indexOf('--');
if (separator < 0) throw new Error('Usage: node --experimental-strip-types scripts/with-instance-maintenance.mjs --user-data <desktop profile> --mcp-url <url> -- <command> [arguments]');
const { values } = parseArgs({ args: process.argv.slice(2, separator), options: {
  'user-data': { type: 'string' }, 'mcp-url': { type: 'string' }, seconds: { type: 'string', default: '600' },
}, strict: true });
const command = process.argv.slice(separator + 1);
const duration = Number(values.seconds) * 1000;
if (!values['user-data'] || !values['mcp-url'] || !command.length
  || !Number.isInteger(Number(values.seconds)) || duration < 1000 || duration > MAX_MAINTENANCE_MS) {
  throw new Error('Supply --user-data, --mcp-url, a command, and a deadline of 1–900 seconds.');
}
const url = new URL(values['mcp-url']);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/mcp') {
  throw new Error('Use the exact credential-free MCP URL selected in the desktop.');
}
const directory = join(values['user-data'], 'instance-maintenance');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = maintenancePath(directory, values['mcp-url']);
const lock = `${file}.lock`;
mkdirSync(lock, { mode: 0o700 });
const record = maintenanceRecordSchema.parse({ id: randomUUID(), mcpUrl: values['mcp-url'],
  startedAt: Date.now(), expiresAt: Date.now() + duration });
const write = value => {
  const temporary = `${file}.${record.id}.tmp`;
  writeFileSync(temporary, JSON.stringify(maintenanceRecordSchema.parse(value)), { mode: 0o600 });
  renameSync(temporary, file);
};
try {
  write(record);
  console.log(`Planned instance maintenance until ${new Date(record.expiresAt).toISOString()}`);
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: false });
  const forward = signal => child.kill(signal);
  const interrupt = () => forward('SIGINT');
  const terminate = () => forward('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status, signal) => signal ? reject(new Error(`Deployment terminated by ${signal}.`)) : resolve(status));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
  if (code !== 0) throw new Error(`Deployment exited with code ${code}.`);
  const response = await fetch(`${url.origin}/health`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  const health = await response.json();
  if (!response.ok || health.ok !== true || typeof health.bootId !== 'string') throw new Error('Deployment did not finish with a healthy backend and boot ID.');
  write({ ...record, completedAt: Date.now(), bootId: health.bootId });
  console.log('Maintenance complete; monitoring will baseline only the verified backend boot ID.');
} catch (error) {
  // An expired, uncompleted record cannot suppress monitoring or accept a new boot ID.
  write({ ...record, expiresAt: Math.min(record.expiresAt, Date.now()) });
  throw error;
} finally {
  rmdirSync(lock);
}
