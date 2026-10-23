import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadHostTaskAdminCredential } from '../control-plane/src/hostTasks';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true }));
});
function tokenFile(content = randomBytes(32).toString('hex'), mode = 0o600) {
  const dir = fs.mkdtempSync(path.resolve('.host-task-token-tests-'));
  dirs.push(dir);
  const filename = path.join(dir, 'admin-token');
  fs.writeFileSync(filename, content, { mode });
  return { dir, filename, content, env: { WM_HOST_TASK_ADMIN_TOKEN_FILE: filename } };
}
function rejectsSafely(env: NodeJS.ProcessEnv, secrets: string[] = [], platform: NodeJS.Platform = process.platform) {
  try {
    loadHostTaskAdminCredential(env, platform);
    expect.fail('Expected protected token file rejection');
  } catch (error) {
    const message = (error as Error).message;
    expect(message).toBe('Unsafe or unavailable host-task admin token file; protected administration remains disabled.');
    for (const secret of secrets) expect(message).not.toContain(secret);
  }
}
describe('explicit protected host-task admin token file', () => {
  it('disables protected administration when the explicit file environment variable is absent', () => {
    expect(loadHostTaskAdminCredential({})).toBeUndefined();
    expect(loadHostTaskAdminCredential({ WM_HOST_TASK_ADMIN_TOKEN: randomBytes(32).toString('hex') })).toBeUndefined();
    expect(loadHostTaskAdminCredential({}, 'win32')).toBeUndefined();
  });
  it('accepts only an owner-readable private regular file and trims a trailing newline', () => {
    const token = randomBytes(32).toString('hex');
    const f = tokenFile(`${token}\n`, 0o400);
    expect(loadHostTaskAdminCredential(f.env)).toBe(token);
  });
  it('does not bootstrap, create, or disclose an unavailable token file', () => {
    const f = tokenFile();
    const missing = path.join(f.dir, 'missing-token');
    rejectsSafely({ WM_HOST_TASK_ADMIN_TOKEN_FILE: missing }, [missing, f.content]);
    expect(fs.existsSync(missing)).toBe(false);
    rejectsSafely({ WM_HOST_TASK_ADMIN_TOKEN_FILE: '' });
  });
  it('rejects final-component symlinks rather than following a private target', () => {
    const f = tokenFile();
    const link = path.join(f.dir, 'link');
    fs.symlinkSync(f.filename, link);
    rejectsSafely({ WM_HOST_TASK_ADMIN_TOKEN_FILE: link }, [f.content, f.filename, link]);
  });
  it('rejects directories and non-regular inputs', () => {
    const f = tokenFile();
    rejectsSafely({ WM_HOST_TASK_ADMIN_TOKEN_FILE: f.dir }, [f.dir, f.content]);
  });
  it.each([0o644, 0o640, 0o604, 0o620, 0o200])('rejects unsafe POSIX token mode %s', mode => {
    const f = tokenFile();
    fs.chmodSync(f.filename, mode);
    rejectsSafely(f.env, [f.content, f.filename]);
  });
  it('rejects token files owned by a different effective daemon user', () => {
    const f = tokenFile();
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    rejectsSafely(f.env, [f.content, f.filename]);
  });
  it('fails closed on Windows because private ACL verification is unavailable', () => {
    const f = tokenFile();
    rejectsSafely(f.env, [f.content, f.filename], 'win32');
  });
  it.each(['', 'weak', 'contains spaces but looks like a long secret', 'x'.repeat(257), 'x'.repeat(4097)])(
    'rejects empty/invalid/oversized token content without echoing it',
    content => {
      const f = tokenFile(content);
      rejectsSafely(f.env, [f.filename, ...(content ? [content] : [])]);
    });
});
