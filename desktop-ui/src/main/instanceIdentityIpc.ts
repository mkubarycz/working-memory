import { z } from 'zod';
import { assertHostTaskSender, type HostTaskIpcDependencies } from './hostTaskIpc';
import { hostTaskOrigin } from './hostTaskBroker';
import type { DesktopInstanceIdentity } from './instanceIdentity';
import { instancePermissionsSchema } from '../../../control-plane/src/instancePermissions';
import { sessionPolicySchema } from '../../../control-plane/src/sessionPolicy';

export function registerInstanceIdentityIpc(deps: HostTaskIpcDependencies & {
  identity: DesktopInstanceIdentity;
  onSessionChanged: (mcpUrl: string, authenticated: boolean) => Promise<void>;
}): void {
  let policySave: Promise<unknown> = Promise.resolve();
  const context = (event: Parameters<typeof assertHostTaskSender>[0]) => {
    const window = deps.getWindow(), selected = deps.getEnvironment();
    assertHostTaskSender(event, window, deps.rendererUrl);
    if (!selected) throw new Error('Select a Working Memory instance first.');
    const environment = { ...selected };
    const ensureCurrent = () => {
      assertHostTaskSender(event, deps.getWindow(), deps.rendererUrl);
      if (deps.getWindow() !== window || deps.getEnvironment()?.mcpUrl !== environment.mcpUrl) {
        throw new Error('The selected instance changed. Retry in the current instance.');
      }
    };
    return { window: window!, environment, ensureCurrent };
  };
  deps.ipc.handle('instance:identity', async event => {
    const ctx = context(event), before = deps.vault.session(hostTaskOrigin(ctx.environment.mcpUrl));
    const state = await deps.identity.status(ctx.environment.mcpUrl);
    ctx.ensureCurrent();
    if (state.authenticated && deps.vault.session(hostTaskOrigin(ctx.environment.mcpUrl)) !== before) {
      await deps.onSessionChanged(ctx.environment.mcpUrl, true);
    }
    return state;
  });
  deps.ipc.handle('instance:sign-in', async (event, raw: unknown) => {
    const ctx = context(event);
    const input = z.object({ password: z.string().min(1).max(1024), setup: z.boolean(),
      passwordHint: z.string().max(1000).default(''), rememberPassword: z.boolean().default(false) }).strict().parse(raw);
    if (input.setup) {
      const approved = await deps.dialog.showMessageBox(ctx.window, {
        type: 'warning', title: 'Working Memory instance owner',
        message: 'Set the owner password for this instance?',
        detail: `Instance: ${hostTaskOrigin(ctx.environment.mcpUrl)}\nThis password controls full access to this instance. `
          + 'Only a salted verifier is stored. Signing in does not approve agent credentials or host-script execution.',
        buttons: ['Cancel', 'Set password'], defaultId: 0, cancelId: 0, noLink: true,
      });
      ctx.ensureCurrent();
      if (approved.response !== 1) return;
    }
    const session = await deps.identity.signIn(ctx.environment.mcpUrl, input.password, input.setup, input.passwordHint, input.rememberPassword);
    ctx.ensureCurrent();
    deps.vault.setSession(hostTaskOrigin(ctx.environment.mcpUrl), session.token, session.expiresAt);
    await deps.onSessionChanged(ctx.environment.mcpUrl, true);
  });
  deps.ipc.handle('instance:sign-out', async event => {
    const ctx = context(event);
    await deps.identity.signOut(ctx.environment.mcpUrl);
    ctx.ensureCurrent();
    await deps.onSessionChanged(ctx.environment.mcpUrl, false);
  });
  deps.ipc.handle('instance:access', async event => {
    const ctx = context(event), snapshot = await deps.identity.access(ctx.environment.mcpUrl);
    ctx.ensureCurrent();
    return snapshot;
  });
  deps.ipc.handle('instance:sessions', async (event, raw: unknown) => {
    const ctx = context(event);
    const before = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional().parse(raw);
    const read = () => {
      ctx.ensureCurrent();
      return deps.identity.sessions(ctx.environment.mcpUrl, before);
    };
    const snapshot = await policySave.then(read, read);
    ctx.ensureCurrent();
    return snapshot;
  });
  deps.ipc.handle('instance:session-policy', async (event, raw: unknown) => {
    const ctx = context(event);
    const { policy, mcpUrl } = z.object({
      policy: sessionPolicySchema, mcpUrl: z.string().min(1),
    }).strict().parse(raw);
    if (mcpUrl !== ctx.environment.mcpUrl) {
      throw new Error('The selected instance changed. Retry in the current instance.');
    }
    const save = async () => {
      ctx.ensureCurrent();
      const snapshot = await deps.identity.sessions(mcpUrl, undefined, policy);
      ctx.ensureCurrent();
      return snapshot;
    };
    const pending = policySave.then(save, save);
    policySave = pending;
    return pending;
  });
  deps.ipc.handle('instance:review-access', async (event, raw: unknown) => {
    const ctx = context(event);
    const action = z.union([
      z.object({ id: z.string().uuid(), action: z.enum(['approve', 'deny', 'revoke']) }).strict(),
      z.object({ id: z.string().uuid(), action: z.literal('permissions'),
        target: z.enum(['request', 'client']), permissions: instancePermissionsSchema }).strict(),
    ]).parse(raw);
    if (action.action === 'approve') {
      const snapshot = await deps.identity.access(ctx.environment.mcpUrl);
      const request = snapshot.requests.find(request => request.id === action.id && request.state === 'pending');
      if (!request) throw new Error('This access request expired or was already reviewed. Refresh the list.');
      ctx.ensureCurrent();
    }
    const snapshot = await deps.identity.access(ctx.environment.mcpUrl, action);
    ctx.ensureCurrent();
    return snapshot;
  });
}
