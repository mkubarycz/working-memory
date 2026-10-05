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
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  return result.status === 0 && output.includes(`"${MAC_LOCAL_CODESIGN_IDENTITY}"`)
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
