import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrateResourceIds } from '../out/control-plane/resourceIdMigration.js';

const args = process.argv.slice(2);
const pathIndex = args.indexOf('--database');
if (pathIndex === -1 || !args[pathIndex + 1] ||
    args.some((arg, index) => index !== pathIndex + 1 && !['--database', '--apply'].includes(arg))) {
  throw new Error('Usage: node scripts/upgrade-resource-ids.mjs --database PATH [--apply]. Stop the desktop/backend first. Omit --apply for a dry run.');
}
const filename = resolve(args[pathIndex + 1]);
if (!existsSync(filename)) throw new Error(`Database does not exist: ${filename}`);
const apply = args.includes('--apply');
const db = new DatabaseSync(filename);
try {
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON');
  if (apply) {
    const backup = `${filename}.before-resource-ids-${Date.now()}.sqlite`;
    db.prepare('VACUUM INTO ?').run(backup);
    console.log(`Backup: ${backup}`);
  }
  const result = migrateResourceIds(db, { repairLegacyData: true, dryRun: !apply });
  console.log(JSON.stringify({ applied: apply, ...result }, null, 2));
} finally {
  db.close();
}
