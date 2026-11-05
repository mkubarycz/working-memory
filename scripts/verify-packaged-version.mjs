import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(root, 'desktop-ui', 'package.json'));
const { extractFile } = require('@electron/asar');
const archives = {
  mac: 'mac-arm64/Working Memory.app/Contents/Resources/app.asar',
  win: 'win-unpacked/resources/app.asar',
};
const archive = archives[process.argv[2]];
const expected = process.env.EXPECTED_VERSION;
if (!archive || !expected) {
  throw new Error('Usage: EXPECTED_VERSION=X.Y.Z node scripts/verify-packaged-version.mjs <mac|win>');
}
const path = join(root, 'desktop-ui', 'release', archive);
const packaged = JSON.parse(extractFile(path, 'package.json').toString('utf8'));
if (packaged.version !== expected) {
  throw new Error(`Packaged desktop reports ${packaged.version}; expected ${expected}.`);
}
console.log(`Verified packaged desktop version ${expected}`);
