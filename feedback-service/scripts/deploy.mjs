import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const [resourceGroup, app] = process.argv.slice(2);
let temporary;
try {
  if (!resourceGroup || !/^[a-z0-9-]{2,60}$/.test(app ?? '')) throw new Error('Usage: npm run deploy -- <resource-group> <function-app>');
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd, stdio: 'pipe' });
  temporary = await mkdtemp(join(tmpdir(), 'wm-feedback-deploy-'));
  const archive = join(temporary, 'service.zip');
  execFileSync('zip', ['-q', '-r', archive, 'host.json', 'package.json', 'package-lock.json', 'src', 'node_modules'], { cwd, stdio: 'pipe' });
  execFileSync('az', ['functionapp', 'deployment', 'source', 'config-zip', '-g', resourceGroup, '-n', app,
    '--src', archive, '--build-remote', 'false', '--only-show-errors', '--output', 'none'], { stdio: 'pipe' });
  console.log(`Service package deployed to https://${app}.azurewebsites.net/api/configuration. Verify that endpoint and device pairing before shipping the desktop.`);
} catch {
  console.error('Deployment failed. Check arguments, Azure login, Function App Node22 runtime, zip/npm availability and deployment permissions. Command output was suppressed to protect credentials.');
  process.exitCode = 1;
} finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
