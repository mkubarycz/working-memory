import { z } from 'zod';
import { HostTaskCredentialVault, hostTaskOrigin } from './hostTaskBroker';

const statusSchema = z.object({ passwordConfigured: z.boolean(), scope: z.literal('host-tasks-preview') });
const sessionSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{32,256}$/), expiresAt: z.number().int(),
  identityId: z.string().uuid(), role: z.literal('owner'),
});

export class DesktopInstanceIdentity {
  constructor(
    private readonly vault: HostTaskCredentialVault,
    private readonly bootstrap: (mcpUrl: string) => Promise<string>,
    private readonly canBootstrap: (mcpUrl: string) => boolean,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async request(mcpUrl: string, path: string, input?: object, token?: string): Promise<unknown> {
    const response = await this.fetcher(`${hostTaskOrigin(mcpUrl)}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Incorrect password or expired session. Sign in to this instance again.');
      if (response.status === 429) throw new Error('Too many sign-in attempts. Try again in a minute.');
      if (response.status === 409) throw new Error('Instance setup changed. Refresh the connection and try again.');
      throw new Error(`Instance connection failed (HTTP ${response.status}). Check that this instance supports password sign-in.`);
    }
    return response.json();
  }

  async status(mcpUrl: string): Promise<{ passwordConfigured: boolean; setupAvailable: boolean }> {
    const status = statusSchema.parse(await this.request(mcpUrl, '/identity/v1/status'));
    return { passwordConfigured: status.passwordConfigured, setupAvailable: this.canBootstrap(mcpUrl) };
  }

  async signIn(mcpUrl: string, password: unknown, setup: boolean): Promise<{ token: string; expiresAt: number }> {
    const checked = z.string().min(setup ? 12 : 1).max(1024).parse(password);
    if (setup && !this.canBootstrap(mcpUrl)) throw new Error('Only the local instance owner can set its initial password.');
    const session = sessionSchema.parse(await this.request(mcpUrl,
      setup ? '/host-tasks/v1/admin/identity/setup' : '/identity/v1/login',
      { password: checked }, setup ? await this.bootstrap(mcpUrl) : undefined));
    return { token: session.token, expiresAt: session.expiresAt };
  }

  async signOut(mcpUrl: string): Promise<void> {
    const origin = hostTaskOrigin(mcpUrl), token = this.vault.session(origin);
    if (token) await this.request(mcpUrl, '/identity/v1/logout', {}, token);
    this.vault.clearSession(origin);
  }
}
