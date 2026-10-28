import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { accessSync } from 'node:fs';

const command = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(() => {}, { [promisify.custom]: command }) };
});
vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  accessSync: vi.fn(),
}));

import { githubCliPath, githubCliToken } from '../src/main/githubCliAuth';

const installedPath = process.platform === 'win32'
  ? 'C:\\Program Files\\GitHub CLI\\gh.exe' : '/usr/local/bin/gh';

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('PATH', '/usr/bin:/bin');
  vi.stubEnv('ProgramFiles', 'C:\\Program Files');
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) vi.stubEnv(name, '');
  vi.mocked(accessSync).mockImplementation(path => {
    if (path !== installedPath) throw Object.assign(new Error('Not found'), { code: 'ENOENT' });
  });
  command.mockResolvedValue({ stdout: 'gho_unit-test\n', stderr: '' });
});
afterEach(() => vi.unstubAllEnvs());

describe('GitHub CLI authentication', () => {
  it('finds Homebrew GitHub CLI when a GUI launch lacks its PATH entry', () => {
    expect(githubCliPath({ PATH: '/usr/bin:/bin' }, 'darwin', path => path === '/opt/homebrew/bin/gh'))
      .toBe('/opt/homebrew/bin/gh');
  });

  it('finds Windows installations without invoking a shell launcher', () => {
    expect(githubCliPath({ Path: 'C:\\Windows', ProgramFiles: 'D:\\Programs' }, 'win32',
      path => path === 'D:\\Programs\\GitHub CLI\\gh.exe')).toBe('D:\\Programs\\GitHub CLI\\gh.exe');
  });

  it('ignores relative PATH entries', () => {
    const exists = vi.fn(() => false);
    githubCliPath({ PATH: '.:tools:/usr/bin' }, 'linux', exists);
    expect(exists.mock.calls.every(([path]) => path.startsWith('/'))).toBe(true);
  });

  it('reads the active account token into native memory with no token command arguments', async () => {
    expect(await githubCliToken()).toBe('gho_unit-test');
    expect(command).toHaveBeenCalledWith(installedPath, ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8', timeout: 10_000, windowsHide: true,
      env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' }),
    });
  });

  it.each(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'])('does not replace an explicit %s identity', async name => {
    vi.stubEnv(name, 'explicit-unit-test');
    expect(await githubCliToken()).toBeUndefined();
    expect(command).not.toHaveBeenCalled();
  });

  it('does not use the enclosing agent session as GitHub CLI authentication', async () => {
    vi.stubEnv('COPILOT_SDK_AUTH_TOKEN', 'unrelated-agent-session');
    expect(await githubCliToken()).toBe('gho_unit-test');
  });

  it('lets the caller surface missing sign-in or an unavailable executable', async () => {
    command.mockRejectedValueOnce({ code: 1 });
    expect(await githubCliToken()).toBeUndefined();
    vi.mocked(accessSync).mockImplementation(() => { throw Object.assign(new Error('Not found'), { code: 'ENOENT' }); });
    expect(await githubCliToken()).toBeUndefined();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('surfaces credential-store failures without leaking captured token output', async () => {
    command.mockRejectedValueOnce(Object.assign(new Error('failed: gho_secret-output'), {
      code: 'ETIMEDOUT', stdout: 'gho_secret-output',
    }));
    await expect(githubCliToken()).rejects.toThrow('Unable to read GitHub CLI sign-in');
  });
});
