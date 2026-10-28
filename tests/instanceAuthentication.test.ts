import { afterEach, expect, it, vi } from 'vitest';
import { ControlPlaneClient } from '../shared/controlPlaneClient';

afterEach(() => vi.unstubAllEnvs());

it.each([
  ['WM_INSTANCE_TOKEN', 'invalid', /Invalid instance credential/],
  ['WM_INSTANCE_TOKEN_FILE', '/nonexistent/wm-instance-credential', /Cannot read the instance credential file/],
])('reports actionable authentication errors for %s instead of claiming the control plane is stopped', async (variable, value, message) => {
  vi.stubEnv('WM_INSTANCE_TOKEN', '');
  vi.stubEnv('WM_INSTANCE_TOKEN_FILE', '');
  vi.stubEnv(variable, value);
  const client = new ControlPlaneClient({ resolveUrl: () => 'http://127.0.0.1:1/mcp' });
  try {
    expect(await client.listDocuments()).toMatchObject({ available: false, error: expect.stringMatching(message) });
  } finally {
    await client.dispose();
  }
});
