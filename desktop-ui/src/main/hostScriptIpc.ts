import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { assertHostTaskSender, type HostTaskIpcDependencies } from './hostTaskIpc';
import { hostTaskOrigin } from './hostTaskBroker';
import { HostScriptAdminClient } from './hostScriptClient';
import { executeHostScript, hostScriptHostId, HOST_SCRIPT_EXAMPLE, HOST_SCRIPT_EXAMPLE_PARAMETERS } from './hostScriptRunner';
import {
  scriptDefinitionSchema, scriptDefinitionHash, scriptParametersSchema, validateScriptArguments, type ScriptArguments,
} from '../../../control-plane/src/hostScriptPolicy';
import type { HostScriptDesktopState } from '../shared/hostTasks';
import type { DesktopInstanceIdentity } from './instanceIdentity';

export function registerHostScriptIpc(deps: HostTaskIpcDependencies & {
  directory: string;
  execute?: typeof executeHostScript;
  identity?: DesktopInstanceIdentity;
}): void {
  let running: AbortController | null = null;
  const context = (event: Parameters<typeof assertHostTaskSender>[0]) => {
    const window = deps.getWindow();
    assertHostTaskSender(event, window, deps.rendererUrl);
    const environment = deps.getEnvironment();
    if (!environment) throw new Error('Select a Working Memory environment first');
    hostTaskOrigin(environment.mcpUrl);
    if (deps.platform === 'win32') throw new Error('Generic scripts currently run on macOS and Linux; Thrive remains separate');
    const ensureCurrent = () => {
      assertHostTaskSender(event, deps.getWindow(), deps.rendererUrl);
      if (deps.getWindow() !== window || deps.getEnvironment()?.mcpUrl !== environment.mcpUrl) {
        throw new Error('Selected desktop or environment changed');
      }
    };
    const client = async () => {
      const token = deps.identity ? deps.vault.session(hostTaskOrigin(environment.mcpUrl))
        : await deps.vault.read(hostTaskOrigin(environment.mcpUrl));
      ensureCurrent();
      if (!token) throw new Error('Sign in to this Working Memory instance first.');
      return new HostScriptAdminClient(environment.mcpUrl, token);
    };
    const confirm = async (message: string, detail: string, scriptWarning = true) => {
      const result = await deps.dialog.showMessageBox(window!, {
        type: 'warning', title: scriptWarning ? 'Approved host script' : 'Working Memory instance setup', message,
        detail: `Environment: ${hostTaskOrigin(environment.mcpUrl)}\n${detail}\n\n`
          + (scriptWarning ? 'Trusted code runs as your local account, without elevation. This is NOT an OS sandbox. '
            + 'Only register scripts you have reviewed. Caller parameters cannot choose the script, shell command, or environment.'
            : 'The password is stored only as a salted verifier. Signing in does not approve any script run.'),
        buttons: ['Cancel', 'Approve'], defaultId: 0, cancelId: 0, noLink: true,
      });
      ensureCurrent();
      return result.response === 1;
    };
    return { window: window!, environment, ensureCurrent, client, confirm };
  };
  deps.ipc.handle('host-scripts:get', async (event): Promise<HostScriptDesktopState> => {
    const ctx = context(event);
    const hostId = await hostScriptHostId(deps.directory);
    const authentication = await deps.identity?.status(ctx.environment.mcpUrl);
    const token = deps.identity ? deps.vault.session(hostTaskOrigin(ctx.environment.mcpUrl))
      : await deps.vault.read(hostTaskOrigin(ctx.environment.mcpUrl));
    ctx.ensureCurrent();
    return { environment: hostTaskOrigin(ctx.environment.mcpUrl), hostId, credentialReady: !!token, authentication,
      snapshot: token ? await new HostScriptAdminClient(ctx.environment.mcpUrl, token).scripts() : null };
  });
  deps.ipc.handle('host-scripts:sign-in', async (event, raw: unknown) => {
    const ctx = context(event);
    if (!deps.identity) throw new Error('Instance sign-in is unavailable.');
    const input = z.object({ password: z.string().min(1).max(1024), setup: z.boolean() }).strict().parse(raw);
    if (input.setup && !await ctx.confirm('Set the owner password for this Working Memory instance?',
      'This creates the instance owner identity. The desktop session can manage all approved scripts and caller grants. '
      + 'It does not approve script execution or give container apps owner access.', false)) return;
    const session = await deps.identity.signIn(ctx.environment.mcpUrl, input.password, input.setup);
    ctx.ensureCurrent();
    deps.vault.setSession(hostTaskOrigin(ctx.environment.mcpUrl), session.token, session.expiresAt);
  });
  deps.ipc.handle('host-scripts:sign-out', async (event) => {
    const ctx = context(event);
    if (!deps.identity) throw new Error('Instance sign-in is unavailable.');
    running?.abort();
    await deps.identity.signOut(ctx.environment.mcpUrl);
    ctx.ensureCurrent();
  });
  deps.ipc.handle('host-scripts:register', async (event, raw: unknown) => {
    const ctx = context(event);
    const input = z.object({
      name: z.string(), description: z.string(), parameters: scriptParametersSchema,
      timeoutMs: z.number().int(), example: z.boolean(),
    }).strict().parse(raw);
    let source = HOST_SCRIPT_EXAMPLE;
    if (!input.example) {
      const selected = await deps.dialog.showOpenDialog(ctx.window, {
        title: 'Choose a reviewed, self-contained CommonJS script',
        properties: ['openFile'], filters: [{ name: 'Node.js CommonJS', extensions: ['cjs', 'js'] }],
      });
      ctx.ensureCurrent();
      if (selected.canceled || selected.filePaths.length !== 1) return;
      const file = await open(selected.filePaths[0], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 32768 || !stat.size) throw new Error('Choose a regular script file up to 32 KiB');
        source = await file.readFile('utf8');
      } finally { await file.close(); }
    }
    const definition = scriptDefinitionSchema.parse({
      name: input.example ? 'Hello from this host' : input.name,
      description: input.example ? 'Harmless example: returns a greeting and the local Node version. No file or network access.' : input.description,
      source, hostId: await hostScriptHostId(deps.directory),
      parameters: input.example ? HOST_SCRIPT_EXAMPLE_PARAMETERS : input.parameters,
      timeoutMs: input.timeoutMs,
    });
    const broker = await ctx.client();
    if (!await ctx.confirm('Register and approve this exact script version?',
      `Name: ${definition.name}\nSHA-256: ${scriptDefinitionHash(definition)}\n`
      + `Parameters: ${JSON.stringify(definition.parameters)}\nTime limit: ${definition.timeoutMs} ms\n`
      + 'A private broker snapshot is used; later edits to the original file do not change this version. '
      + 'Only built-in Node modules are supported. Dependencies and OS permissions are not sandboxed.\n\n'
      + `Script:\n${source}`)) return;
    ctx.ensureCurrent();
    return broker.registerScript(definition);
  });
  deps.ipc.handle('host-scripts:grant', async (event, raw: unknown) => {
    const ctx = context(event);
    const input = z.object({ taskId: z.string().uuid(), appId: z.string().uuid(), expiresAt: z.number().int() }).strict().parse(raw);
    if (input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 86400000) throw new Error('Grant must expire within 24 hours');
    const broker = await ctx.client(), snapshot = await broker.scripts();
    const task = snapshot.tasks.find(task => task.id === input.taskId && task.revokedAt === null);
    const app = snapshot.apps.find(app => app.id === input.appId && app.revokedAt === null);
    if (!task || !app || task.hostId !== await hostScriptHostId(deps.directory)) throw new Error('Choose an active caller and a script on this host');
    if (!await ctx.confirm('Allow this caller to run this script until expiry?',
      `Caller: ${app.label} (${app.id})\nScript: ${task.name}\nSHA-256: ${task.definitionHash}\n`
      + `Parameters: ${JSON.stringify(task.parameters)}\nExpires: ${new Date(input.expiresAt).toISOString()}\n`
      + 'The caller can request repeat runs with these bounded parameters while the local runner is active.')) return;
    await broker.grantScript({ ...input, definitionHash: task.definitionHash });
  });
  deps.ipc.handle('host-scripts:revoke', async (event, id: unknown, grant: unknown) => {
    const ctx = context(event);
    const identifier = z.string().uuid().parse(id);
    const isGrant = z.boolean().parse(grant);
    if (!await ctx.confirm(isGrant ? 'Revoke this caller grant?' : 'Revoke this script version?',
      'Queued runs and result access will be cancelled. A running process is stopped at the next status check; already completed host side effects cannot be undone.')) return;
    const broker = await ctx.client();
    if (isGrant) await broker.revokeScriptGrant(identifier);
    else await broker.revokeScript(identifier);
  });
  deps.ipc.handle('host-scripts:test', async (event, id: unknown, raw: unknown) => {
    const ctx = context(event);
    const broker = await ctx.client(), snapshot = await broker.scripts();
    const task = snapshot.tasks.find(task => task.id === z.string().uuid().parse(id) && task.revokedAt === null);
    if (!task || task.hostId !== await hostScriptHostId(deps.directory)) throw new Error('Choose an active script on this host');
    const parameters: ScriptArguments = validateScriptArguments(task.parameters, raw);
    if (!await ctx.confirm('Queue one local test run?',
      `Script: ${task.name}\nSHA-256: ${task.definitionHash}\nParameters: ${JSON.stringify(parameters)}\n`
      + 'This approves this one test only; it does not grant access to other apps.')) return;
    return broker.testScript({ taskId: task.id, definitionHash: task.definitionHash, parameters, idempotencyKey: randomUUID() });
  });
  deps.ipc.handle('host-scripts:job', async (event, id: unknown) => {
    const ctx = context(event);
    return (await ctx.client()).scriptJob(z.string().uuid().parse(id));
  });
  deps.ipc.handle('host-scripts:stop', async (event) => { context(event); running?.abort(); });
  deps.ipc.handle('host-scripts:next', async (event) => {
    const ctx = context(event);
    if (running) throw new Error('A local host script is already running');
    const controller = new AbortController();
    running = controller;
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const broker = await ctx.client();
      const hostId = await hostScriptHostId(deps.directory);
      const lease = await broker.claimScript(hostId);
      ctx.ensureCurrent();
      if (!lease) return null;
      if (lease.definition.hostId !== hostId) throw new Error('Broker returned a script registered to a different host');
      let checking = false;
      timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void (async () => {
          try {
            ctx.ensureCurrent();
            if ((await broker.scriptJob(lease.jobId)).state !== 'running') controller.abort();
          } catch { controller.abort(); }
          finally { checking = false; }
        })();
      }, 500);
      let result: { resultJson?: string; error?: string };
      try { result = await (deps.execute ?? executeHostScript)(lease, controller.signal); }
      catch (error) { result = { error: (error instanceof Error ? error.message : String(error)).slice(0, 1000) }; }
      ctx.ensureCurrent();
      const current = await broker.scriptJob(lease.jobId);
      if (current.state !== 'running') return current;
      return await broker.completeScript({ jobId: lease.jobId, leaseToken: lease.leaseToken, ...result });
    } finally {
      if (timer) clearInterval(timer);
      running = null;
    }
  });
}
