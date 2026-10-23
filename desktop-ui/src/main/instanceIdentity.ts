import { z } from 'zod';
import { HostTaskCredentialVault, hostTaskOrigin } from './hostTaskBroker';
import type { InstanceFeatures } from '../../../control-plane/src/instanceFeatures';
import type { InstanceConnectionState, InstanceAccessSnapshot } from '../shared/instanceIdentity';

const statusSchema = z.object({ passwordConfigured: z.boolean(), passwordHint: z.string().max(1000),
  authenticated: z.boolean(), scope: z.literal('instance') });
const accessSchema = z.object({
  requests: z.array(z.object({
    id: z.string().uuid(), label: z.string(), clientId: z.string().uuid().nullable(),
    access: z.enum(['read', 'write']), source: z.string(), state: z.enum(['pending', 'approved']),
    createdAt: z.number().int(), expiresAt: z.number().int(),
  })),
  clients: z.array(z.object({
    id: z.string().uuid(), label: z.string(), access: z.enum(['read', 'write']),
    createdAt: z.number().int(), expiresAt: z.number().int(), revokedAt: z.number().int().nullable(),
  })),
});
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
    private readonly onUnauthorized: (mcpUrl: string) => void = () => {},
  ) {}

  private async request(mcpUrl: string, path: string, input?: object, token?: string): Promise<unknown> {
    const response = await this.fetcher(`${hostTaskOrigin(mcpUrl)}${path}`, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      if (response.status === 401) {
        if (token && this.vault.session(hostTaskOrigin(mcpUrl)) === token) {
          this.vault.clearSession(hostTaskOrigin(mcpUrl));
          this.onUnauthorized(mcpUrl);
        }
        throw new Error('Incorrect password or expired session. Sign in to this instance again.');
      }
      if (response.status === 429) throw new Error('Too many sign-in attempts. Try again in a minute.');
      if (response.status === 409) throw new Error('Instance setup changed. Refresh the connection and try again.');
      throw new Error(`Instance connection failed (HTTP ${response.status}). Check that this instance supports password sign-in.`);
    }
    return response.json();
  }

  async status(mcpUrl: string): Promise<InstanceConnectionState> {
    const origin = hostTaskOrigin(mcpUrl), token = this.vault.session(origin);
    const parsed = statusSchema.safeParse(await this.request(mcpUrl, '/identity/v1/status', undefined, token ?? undefined));
    if (this.vault.session(origin) !== token) return this.status(mcpUrl);
    if (!parsed.success) throw new Error('This instance needs an authentication upgrade. Use Manage instances to upgrade a managed instance, or redeploy a self-hosted backend, then retry.');
    if (!parsed.data.authenticated) {
      this.vault.clearSession(origin);
      this.onUnauthorized(mcpUrl);
    }
    return { environment: origin, passwordConfigured: parsed.data.passwordConfigured, passwordHint: parsed.data.passwordHint,
      authenticated: !!token && parsed.data.authenticated, setupAvailable: this.canBootstrap(mcpUrl) };
  }

  async features(mcpUrl: string): Promise<InstanceFeatures> {
    return z.object({ hostTasks: z.boolean() }).strict().parse(await this.request(mcpUrl, '/features/v1', undefined,
      this.vault.session(hostTaskOrigin(mcpUrl)) ?? undefined));
  }

  async setFeatures(mcpUrl: string, features: InstanceFeatures): Promise<InstanceFeatures> {
    const token = this.vault.session(hostTaskOrigin(mcpUrl));
    if (!token) {
      this.onUnauthorized(mcpUrl);
      throw new Error('Sign in as the instance owner to change features.');
    }
    return z.object({ hostTasks: z.boolean() }).strict().parse(await this.request(mcpUrl, '/features/v1', features, token));
  }

  async signIn(mcpUrl: string, password: unknown, setup: boolean, passwordHint = ''): Promise<{ token: string; expiresAt: number }> {
    const checked = z.string().min(setup ? 12 : 1).max(1024).parse(password);
    if (setup && !this.canBootstrap(mcpUrl)) throw new Error('Only the local instance owner can set its initial password.');
    const session = sessionSchema.parse(await this.request(mcpUrl,
      setup ? '/identity/v1/setup' : '/identity/v1/login',
      { password: checked, ...(setup ? { passwordHint: z.string().max(1000).parse(passwordHint) } : {}) },
      setup ? await this.bootstrap(mcpUrl) : undefined));
    return { token: session.token, expiresAt: session.expiresAt };
  }

  async setPasswordHint(mcpUrl: string, hint: unknown): Promise<void> {
    const token = this.vault.session(hostTaskOrigin(mcpUrl));
    if (!token) throw new Error('Sign in to this instance to change its password hint.');
    await this.request(mcpUrl, '/identity/v1/hint', { passwordHint: z.string().max(1000).parse(hint) }, token);
  }

  async signOut(mcpUrl: string): Promise<void> {
    const origin = hostTaskOrigin(mcpUrl), token = this.vault.session(origin);
    if (token) await this.request(mcpUrl, '/identity/v1/logout', {}, token);
    this.vault.clearSession(origin);
  }

  async access(mcpUrl: string, action?: { id: string; action: 'approve' | 'deny' | 'revoke' }): Promise<InstanceAccessSnapshot> {
    const token = this.vault.session(hostTaskOrigin(mcpUrl));
    if (!token) {
      this.onUnauthorized(mcpUrl);
      throw new Error('Sign in as the instance owner to manage access.');
    }
    return accessSchema.parse(await this.request(mcpUrl, '/identity/v1/access', action, token));
  }
}
