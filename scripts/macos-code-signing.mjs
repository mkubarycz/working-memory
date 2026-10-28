import { spawnSync } from 'node:child_process';

export const MAC_APP_IDENTIFIER = 'com.kubarycz.working-memory';
export const MAC_LOCAL_CODESIGN_IDENTITY = 'Working Memory Local Code Signing';
export const MAC_AD_HOC_DESIGNATED_REQUIREMENT =
  `=designated => identifier "${MAC_APP_IDENTIFIER}"`;

export function resolveMacCodeSignIdentity({
  configuredIdentity = process.env.WM_DESKTOP_CODESIGN_IDENTITY?.trim(),
  platform = process.platform,
  findIdentities = () => spawnSync(
    '/usr/bin/security',
    ['find-identity', '-v', '-p', 'codesigning'],
    { encoding: 'utf8' },
  ),
} = {}) {
  if (configuredIdentity) return configuredIdentity;
  if (platform !== 'darwin') return '-';
  const result = findIdentities();
  if (result.status !== 0) {
    throw new Error(
      `Unable to inspect macOS signing identities: ${result.stderr?.trim() || result.error?.message || `security exited with status ${result.status}`}`,
    );
  }
  const output = result.stdout ?? '';
  const developmentIdentities = [...output.matchAll(/^\s*\d+\)\s+([a-fA-F0-9]{40})\s+"(?:Apple Development:|Mac Developer:)[^"]*"\s*$/gm)];
  if (developmentIdentities.length > 1) {
    throw new Error(
      'Multiple Apple Development signing identities are available. Set WM_DESKTOP_CODESIGN_IDENTITY to the certificate SHA-1 to choose one.',
    );
  }
  if (developmentIdentities.length === 1) return developmentIdentities[0][1];
  return output.includes(`"${MAC_LOCAL_CODESIGN_IDENTITY}"`)
    ? MAC_LOCAL_CODESIGN_IDENTITY
    : '-';
}

export function macCodeSignArguments(
  appBundle,
  {
    deep = false,
    identity = resolveMacCodeSignIdentity(),
  } = {},
) {
  const args = ['--force'];
  if (deep) args.push('--deep');
  args.push('--sign', identity);
  if (identity === '-') {
    args.push(
      '--identifier',
      MAC_APP_IDENTIFIER,
      '--requirements',
      MAC_AD_HOC_DESIGNATED_REQUIREMENT,
    );
  }
  args.push(appBundle);
  return args;
}
