import { execFileSync } from 'node:child_process';

const [resourceGroup, app, account] = process.argv.slice(2);
function az(args) {
  try {
    const output = execFileSync('az', [...args, '--only-show-errors', '--output', 'json'], { encoding: 'utf8', stdio: 'pipe' });
    return JSON.parse(output || 'null');
  } catch { throw new Error(`Azure ${args.slice(0, 3).join(' ')} failed. Check Azure login, subscription and permissions; no command output was printed.`); }
}
try {
  if (!resourceGroup || !/^[a-z0-9-]{2,60}$/.test(app ?? '') || !/^[a-z0-9]{3,24}$/.test(account ?? '')) {
    throw new Error('Usage: node scripts/provision.mjs <existing-resource-group> <existing-function-app> <existing-storage-account>');
  }
  const storage = az(['storage', 'account', 'show', '-g', resourceGroup, '-n', account]);
  const identity = az(['functionapp', 'identity', 'assign', '-g', resourceGroup, '-n', app]);
  for (const container of ['reports', 'feedback-service']) {
    az(['storage', 'container', 'create', '--account-name', account, '--auth-mode', 'login', '--name', container, '--public-access', 'off']);
    const scope = `${storage.id}/blobServices/default/containers/${container}`;
    const assignments = az(['role', 'assignment', 'list', '--scope', scope, '--assignee', identity.principalId]);
    if (!assignments.some(item => item.roleDefinitionName === 'Storage Blob Data Contributor' && item.scope.toLowerCase() === scope.toLowerCase())) {
      az(['role', 'assignment', 'create', '--assignee-object-id', identity.principalId, '--assignee-principal-type', 'ServicePrincipal',
        '--role', 'Storage Blob Data Contributor', '--scope', scope]);
    }
  }
  az(['functionapp', 'update', '-g', resourceGroup, '-n', app, '--set', 'httpsOnly=true']);
  az(['functionapp', 'config', 'appsettings', 'set', '-g', resourceGroup, '-n', app, '--settings',
    `FEEDBACK_STORAGE_ACCOUNT=${account}`, `FEEDBACK_PUBLIC_URL=https://${app}.azurewebsites.net/api`,
    'FUNCTIONS_REQUEST_BODY_SIZE_LIMIT=41943040']);
  console.log('Private containers, scoped managed-identity roles, HTTPS and service settings are configured. Initialize the receiver public key, then deploy. Existing receiver data/configuration was not changed.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
