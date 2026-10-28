import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { posix, win32 } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export function githubCliPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = (path) => {
    try {
      accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return true;
    } catch (error) {
      if (['ENOENT', 'EACCES', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
      throw error;
    }
  },
): string | undefined {
  const paths = platform === 'win32' ? win32 : posix;
  const directories = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':');
  if (platform === 'win32') {
    directories.push(paths.join(env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI'));
    if (env.LOCALAPPDATA) directories.push(paths.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
  } else {
    directories.push('/usr/local/bin', '/usr/bin');
    if (platform === 'darwin') directories.push('/opt/homebrew/bin');
  }
  return directories.filter(directory => paths.isAbsolute(directory))
    .map(directory => paths.join(directory, platform === 'win32' ? 'gh.exe' : 'gh'))
    .find(exists);
}

export async function githubCliToken(): Promise<string | undefined> {
  // An explicitly selected token must fail visibly, not switch GitHub identities.
  if (['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].some(name => process.env[name])) return undefined;
  const path = githubCliPath();
  if (!path) return undefined;
  try {
    const { stdout } = await run(path, ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: { ...process.env, COPILOT_SDK_AUTH_TOKEN: undefined, GH_PROMPT_DISABLED: '1' },
    });
    return stdout.trim() || undefined;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 1) return undefined;
    // execFile errors may include credential-bearing stdout; never expose them.
    throw new Error('Unable to read GitHub CLI sign-in. Run "gh auth status" in Terminal, then retry.');
  }
}
