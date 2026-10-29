import { execFile } from 'node:child_process';
import { accessSync } from 'node:fs';
import { dirname } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecFileCommandRunner } from '../src/main/dockerContainerService';

vi.mock('node:child_process', () => ({
  execFile: vi.fn((_file: string, _args: string[], _options: unknown,
    callback: (error: null, stdout: string, stderr: string) => void) => callback(null, 'ok', '')),
}));
vi.mock('node:fs', () => ({ accessSync: vi.fn(), constants: { F_OK: 0, X_OK: 1 } }));

afterEach(() => { vi.clearAllMocks(); });

describe('Docker command executable discovery', () => {
  const docker = process.platform === 'win32'
    ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe'
    : process.platform === 'darwin'
      ? '/Applications/Docker.app/Contents/Resources/bin/docker'
      : '/usr/local/bin/docker';
  const guiPath = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/usr/bin:/bin';
  const separator = process.platform === 'win32' ? ';' : ':';

  it('finds Docker outside a GUI PATH and exposes credential helpers without changing the caller environment', async () => {
    vi.mocked(accessSync).mockImplementation(candidate => {
      if (candidate !== docker) throw new Error('not found');
    });
    const env = { PATH: guiPath, WM_TEST: 'preserved' };
    const controller = new AbortController();
    await expect(new ExecFileCommandRunner().run('docker', ['--context', 'desktop-linux', 'info'],
      { timeoutMs: 1000, signal: controller.signal, env })).resolves.toEqual({ stdout: 'ok', stderr: '' });
    expect(execFile).toHaveBeenCalledWith(docker, ['--context', 'desktop-linux', 'info'],
      expect.objectContaining({
        timeout: 1000, signal: controller.signal,
        env: expect.objectContaining({ WM_TEST: 'preserved', PATH: expect.any(String) }),
      }), expect.any(Function));
    const options = vi.mocked(execFile).mock.calls[0][2];
    expect(options?.env?.PATH?.split(separator)[0]).toBe(dirname(docker));
    expect(env).toEqual({ PATH: guiPath, WM_TEST: 'preserved' });
  });

  it('reports a missing CLI explicitly without attempting to spawn it', async () => {
    vi.mocked(accessSync).mockImplementation(() => { throw new Error('not found'); });
    await expect(new ExecFileCommandRunner().run('docker', ['info'], { timeoutMs: 1000, env: { PATH: guiPath } }))
      .rejects.toMatchObject({ code: 'ENOENT', message: expect.stringContaining('Install Docker Desktop') });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('preserves explicit executable paths and non-Docker commands', async () => {
    const env = { PATH: guiPath };
    for (const executable of [docker, process.execPath]) {
      await new ExecFileCommandRunner().run(executable, ['--version'], { timeoutMs: 1000, env });
      expect(execFile).toHaveBeenLastCalledWith(executable, ['--version'],
        expect.objectContaining({ env }), expect.any(Function));
    }
    expect(accessSync).not.toHaveBeenCalled();
  });
});
