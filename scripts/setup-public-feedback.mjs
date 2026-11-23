import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith('--') || !value || value.startsWith('--')) throw new Error('Use --resource-group, --account, --sender-output and optional --location/--container.');
  options.set(name, value);
}
const resourceGroup = options.get('--resource-group');
const account = options.get('--account');
const output = options.get('--sender-output');
const location = options.get('--location') ?? 'eastus2';
const container = options.get('--container') ?? 'working-memory-feedback';
if (!resourceGroup || !/^[a-z0-9]{3,24}$/.test(account ?? '') || !output) {
  throw new Error('A resource group, valid Azure storage account name and private sender-output path are required.');
}
const destination = resolve(output);
const repository = resolve(new URL('..', import.meta.url).pathname);
if (destination === repository || destination.startsWith(`${repository}/`)) throw new Error('Keep sender credentials outside the repository.');

function azure(args, format = 'json') {
  try {
    const text = execFileSync('az', [...args, '--only-show-errors', '--output', format], { encoding: 'utf8', stdio: 'pipe' }).trim();
    return format === 'json' ? JSON.parse(text || 'null') : text;
  } catch {
    throw new Error(`Azure ${args.slice(0, 3).join(' ')} failed. Check your selected subscription, permissions and resource configuration; credentials were not printed.`);
  }
}

azure(['storage', 'account', 'create', '--name', account, '--resource-group', resourceGroup, '--location', location,
  '--kind', 'StorageV2', '--sku', 'Standard_LRS', '--https-only', 'true', '--min-tls-version', 'TLS1_2',
  '--allow-blob-public-access', 'false', '--allow-shared-key-access', 'true', '--public-network-access', 'Enabled']);
const keys = azure(['storage', 'account', 'keys', 'list', '--account-name', account, '--resource-group', resourceGroup]);
if (!Array.isArray(keys) || typeof keys[0]?.value !== 'string') throw new Error('Azure did not return a storage signing key.');
const accountKey = keys[0].value;
azure(['storage', 'container', 'create', '--account-name', account, '--account-key', accountKey, '--name', 'reports', '--public-access', 'off']);
const expiry = new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const sas = permissions => azure(['storage', 'container', 'generate-sas', '--account-name', account, '--account-key', accountKey,
  '--name', 'reports', '--permissions', permissions, '--https-only', '--expiry', expiry], 'tsv');
let publicKey;
try {
  publicKey = execFileSync('docker', ['exec', container, 'node', '--input-type=module', '-e',
    "import {inboxKey} from './src/publicInbox.js'; console.log(inboxKey().publicKey);"], { encoding: 'utf8', stdio: 'pipe' }).trim() + '\n';
} catch { throw new Error('Build and start the updated Feedback container before provisioning its public inbox.'); }
const base = `https://${account}.blob.core.windows.net/reports`;
const sender = { version: 1, uploadUrl: `${base}?${sas('c')}`, publicKey };
const receiver = JSON.stringify({ pullUrl: `${base}?${sas('rdl')}` });
try {
  execFileSync('docker', ['exec', '-i', container, 'node', '--input-type=module', '-e',
    "import {mkdirSync,writeFileSync,renameSync} from 'node:fs'; let input=''; for await (const chunk of process.stdin) input+=chunk; JSON.parse(input); mkdirSync('/data/public-inbox',{recursive:true,mode:0o700}); writeFileSync('/data/public-inbox/config.json.tmp',input,{mode:0o600}); renameSync('/data/public-inbox/config.json.tmp','/data/public-inbox/config.json');"],
  { input: receiver, stdio: 'pipe' });
} catch { throw new Error('The receiver configuration could not be installed; no receiver credential was printed.'); }
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
writeFileSync(destination, JSON.stringify(sender, null, 2), { mode: 0o600, flag: 'wx' });
console.log(`Public inbox ready: ${base}`);
console.log(`Sender setup saved privately to ${destination}. Import it in Settings > Feedback on each sending computer.`);
console.log(`Credentials expire ${expiry}. Restart the Feedback container to begin pulling reports.`);
