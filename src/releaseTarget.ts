const supportedTargets = new Set([
  'darwin-arm64',
  'darwin-x64',
  'linux-x64',
  'win32-x64',
]);

export function releaseTarget(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  const target = `${platform}-${arch}`;
  if (!supportedTargets.has(target)) {
    throw new Error(
      `no published Working Memory release supports ${target}; supported targets are ${[...supportedTargets].join(', ')}`,
    );
  }
  return target;
}

export function releaseAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string {
  return `working-memory-${releaseTarget(platform, arch)}.vsix`;
}
