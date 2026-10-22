<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { HostScriptDesktopState, ScriptJob } from '../shared/hostTasks';

  let state = $state<HostScriptDesktopState | null>(null);
  let error = $state('');
  let busy = $state(false);
  let runnerActive = $state(false);
  let processing = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let name = $state('');
  let description = $state('');
  let parameters = $state('{\n  "name": { "type": "string", "required": true, "maxLength": 80 }\n}');
  let taskId = $state('');
  let appId = $state('');
  let argumentsJson = $state('{"name":"Michael"}');
  let selectedJob = $state<ScriptJob | null>(null);
  let callerLabel = $state('My agent');

  async function refresh(): Promise<void> { state = await window.workingMemory.getHostScripts(); }
  async function perform(action: () => Promise<unknown>): Promise<void> {
    busy = true;
    error = '';
    try { await action(); await refresh(); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  async function register(example: boolean): Promise<void> {
    await perform(async () => {
      const task = await window.workingMemory.registerHostScript({
        name, description, parameters: example ? {} : JSON.parse(parameters), timeoutMs: 10000, example,
      });
      if (task) taskId = task.id;
    });
  }
  async function tick(): Promise<void> {
    if (!runnerActive || processing) return;
    processing = true;
    try {
      const job = await window.workingMemory.processNextHostScript();
      if (job) selectedJob = job;
      await refresh();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      runnerActive = false;
      if (timer) clearInterval(timer);
    } finally { processing = false; }
  }
  function startRunner(): void {
    runnerActive = true;
    error = '';
    timer = setInterval(() => void tick(), 1500);
    void tick();
  }
  async function stopRunner(): Promise<void> {
    runnerActive = false;
    if (timer) clearInterval(timer);
    await perform(() => window.workingMemory.stopHostScript());
  }
  onDestroy(() => {
    runnerActive = false;
    if (timer) clearInterval(timer);
  });
</script>

<section class="scripts" aria-label="Approved Node.js host scripts">
  <p><strong>Your script. Your parameter contract. Your approval.</strong>
    Register a self-contained CommonJS script, then test it or grant a caller access to that exact version.
    Scripts run as your local account on this Mac/Linux host, <strong>not in a sandbox</strong>.</p>
  <p>Only Node.js built-in modules are supported in this first version. Script changes require a new registration.
    The unfinished Windows/Thrive runner is separate.</p>
  <div class="actions">
    <button disabled={busy} onclick={() => void perform(async () => {})}>Connect / refresh</button>
    <button disabled={busy} onclick={() => void perform(() => window.workingMemory.provisionHostTaskAdmin())}>Import broker admin token…</button>
  </div>
  <p class="hint">Setup uses the existing protected broker credential. macOS may request Keychain access to unlock
    local credential storage; that is not a task approval. If administration is disabled, configure
    <code>WM_HOST_TASK_ADMIN_TOKEN_FILE</code> on the control plane, then import that private file here.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if state}
    <p>Environment: <code>{state.environment}</code> · Host: <code>{state.hostId}</code></p>
    {#if !state.credentialReady}<p>No admin credential imported yet. Nothing can run.</p>{/if}
    {#if state.snapshot}
      <h3>1. Register a script</h3>
      <button disabled={busy} onclick={() => void register(true)}>Register harmless greeting example…</button>
      <details>
        <summary>Register my own script</summary>
        <label>Name <input bind:value={name} maxlength="100" /></label>
        <label>Description <input bind:value={description} maxlength="1000" /></label>
        <label>Allowed parameters (JSON)<textarea bind:value={parameters} rows="6"></textarea></label>
        <p>Types: <code>string</code> with <code>maxLength</code> and optional <code>enum</code>;
          <code>integer</code> with <code>minimum</code>/<code>maximum</code>; <code>boolean</code>.
          Add <code>"required": true</code> when needed. Unknown parameters are rejected.</p>
        <pre>module.exports = async function (parameters) &#123;
  return &#123; greeting: "Hello, " + parameters.name &#125;;
&#125;;</pre>
        <button disabled={busy || !name.trim()} onclick={() => void register(false)}>Choose script and review approval…</button>
      </details>
      <h3>2. Test locally</h3>
      <label>Script
        <select bind:value={taskId}>
          <option value="">Select a script</option>
          {#each state.snapshot.tasks.filter(task => !task.revokedAt && task.hostId === state?.hostId) as task}
            <option value={task.id}>{task.name}</option>
          {/each}
        </select>
      </label>
      <label>Parameters (JSON)<textarea bind:value={argumentsJson} rows="3"></textarea></label>
      <div class="actions">
        <button disabled={busy || !taskId} onclick={() => void perform(async () => {
          const job = await window.workingMemory.testHostScript(taskId, JSON.parse(argumentsJson));
          if (job) selectedJob = job;
        })}>Review and queue one test…</button>
        {#if runnerActive}
          <button onclick={() => void stopRunner()}>Stop local runner</button>
        {:else}
          <button disabled={busy} onclick={startRunner}>Start local runner</button>
        {/if}
      </div>
      <p role="status">Local runner: {runnerActive ? (processing ? 'checking / running' : 'waiting for approved jobs') : 'stopped'}.
        It polls only while this panel is open. Closing the panel stops new claims; an in-progress run may finish.
        Runs are limited to 10 seconds here, with 64 KiB JSON results. Console logs are not returned.</p>
      {#if selectedJob}
        <h4>Selected run: {selectedJob.state}</h4>
        <pre>{selectedJob.error ?? selectedJob.resultJson ?? 'Queued — start the local runner to execute.'}</pre>
      {/if}
      <h3>3. Allow another caller</h3>
      <p>Export a separate credential for the requesting app, then approve an expiring grant.
        A credential alone cannot run any script.</p>
      <label>Caller label <input bind:value={callerLabel} maxlength="100" /></label>
      <button disabled={busy || !callerLabel.trim()} onclick={() => void perform(() => window.workingMemory.exportHostTaskApp({
        label: callerLabel, instanceId: `host-script-${crypto.randomUUID()}`,
      }))}>Export new caller credential…</button>
      <label>Caller
        <select bind:value={appId}>
          <option value="">Select a caller</option>
          {#each state.snapshot.apps.filter(app => !app.revokedAt) as app}
            <option value={app.id}>{app.label} ({app.id})</option>
          {/each}
        </select>
      </label>
      <button disabled={busy || !taskId || !appId} onclick={() => void perform(() => window.workingMemory.grantHostScript({
        taskId, appId, expiresAt: Date.now() + 3600000,
      }))}>Review one-hour script grant…</button>
      <p>Authenticated API: <code>GET /host-tasks/v1/scripts</code>, <code>POST /host-tasks/v1/scripts/requests</code>,
        and <code>GET /host-tasks/v1/scripts/jobs/&lt;id&gt;</code>. Send the caller credential in the Authorization
        bearer header, never in a URL or chat. Requests contain <code>taskId</code>, <code>definitionHash</code>,
        <code>parameters</code>, and a stable <code>idempotencyKey</code>. See the README for the complete example.</p>
      <p>For agents, connect a separate authenticated MCP server at
        <code>{state.environment}/host-tasks/v1/scripts/mcp</code> using the caller's bearer credential.
        Only that caller's granted script versions are exposed as tools. Never use the admin credential for agents.</p>
      <h3>Registered versions</h3>
      {#each state.snapshot.tasks as task}
        <article>
          <strong>{task.name}</strong> · {task.revokedAt ? 'revoked' : task.hostId === state.hostId ? 'this host' : 'another host'}
          <p>{task.description}</p>
          <code>{task.id}</code><br /><code>SHA-256: {task.definitionHash}</code>
          <pre>{JSON.stringify(task.parameters, null, 2)}</pre>
          <button disabled={busy || !!task.revokedAt} onclick={() => void perform(() => window.workingMemory.revokeHostScript(task.id, false))}>Revoke version…</button>
        </article>
      {:else}<p>No scripts registered. Start with the greeting example.</p>{/each}
      <h3>Caller grants</h3>
      {#each state.snapshot.grants as grant}
        <p>{state.snapshot.tasks.find(task => task.id === grant.taskId)?.name} · caller {grant.appId} ·
          {grant.revokedAt ? 'revoked' : `expires ${new Date(grant.expiresAt).toLocaleString()}`}
          <button disabled={busy || !!grant.revokedAt} onclick={() => void perform(() => window.workingMemory.revokeHostScript(grant.id, true))}>Revoke grant…</button>
        </p>
      {:else}<p>No callers have script access.</p>{/each}
      <h3>Recent runs</h3>
      {#each state.snapshot.jobs as job}
        <p>{state.snapshot.tasks.find(task => task.id === job.taskId)?.name} · {job.appId ?? 'owner test'} · {job.state}
          <button disabled={busy} onclick={() => void perform(async () => {
            selectedJob = await window.workingMemory.getHostScriptJob(job.id);
          })}>Inspect result</button>
        </p>
      {:else}<p>No runs yet.</p>{/each}
    {/if}
  {/if}
</section>

<style>
  .scripts { display: grid; gap: 10px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  label { display: grid; gap: 4px; }
  input, select, textarea { width: 100%; box-sizing: border-box; }
  textarea, pre, code { font-family: var(--vscode-editor-font-family, monospace); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; }
  article { padding: 10px; border: 1px solid var(--vscode-widget-border, #555); border-radius: 5px; }
  .error { color: var(--vscode-errorForeground, #e55); }
  .hint { color: var(--vscode-descriptionForeground); }
</style>
