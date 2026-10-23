<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { HostScriptDesktopState, ScriptJob } from '../shared/hostTasks';

  let { connectionOnly = false, onConnectionChanged }: {
    connectionOnly?: boolean; onConnectionChanged?: (connected: boolean) => void;
  } = $props();
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
  let argumentsJson = $state('{}');
  let selectedJob = $state<ScriptJob | null>(null);
  let callerLabel = $state('My agent');
  let password = $state('');
  let repeatedPassword = $state('');
  let passwordHint = $state('');
  let addingScript = $state(false);
  let showRevoked = $state(false);
  const creatingPassword = $derived(state?.authentication?.passwordConfigured === false);
  const visibleTasks = $derived(state?.snapshot?.tasks.filter(task => showRevoked || !task.revokedAt) ?? []);
  const selectedTask = $derived(visibleTasks.find(task => task.id === taskId) ?? null);
  const canRunSelectedTask = $derived(!!selectedTask && !selectedTask.revokedAt && selectedTask.hostId === state?.hostId);

  async function signIn(): Promise<void> {
    if (creatingPassword && password !== repeatedPassword) { error = 'The passwords do not match.'; return; }
    const value = password;
    password = '';
    repeatedPassword = '';
    await perform(() => window.workingMemory.signInHostScripts({
      password: value, setup: creatingPassword, ...(creatingPassword ? { passwordHint } : {}),
    }));
  }

  onMount(() => { void perform(async () => {}); });

  async function refresh(): Promise<void> {
    state = await window.workingMemory.getHostScripts();
    onConnectionChanged?.(state.credentialReady);
  }
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
      if (task) {
        taskId = task.id;
        argumentsJson = '{}';
        selectedJob = null;
        addingScript = false;
      }
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

<section class="scripts" aria-label="Approved host tasks">
  {#if !connectionOnly}<p>Scripts you have approved. Select a task to run a test or manage who can request it.</p>{/if}
  {#if !state?.credentialReady}
    <h3>{creatingPassword ? 'Set this instance’s owner password' : 'Connect to your Working Memory instance'}</h3>
    <p>The control plane stores your scripts and approvals. Sign in as its owner to manage them.
      This connection does not approve a script or give an agent permission to run anything.</p>
    {#if creatingPassword}
      <p>Choose a password of at least 12 characters. Initial setup must be performed by the local instance owner.</p>
      {#if !state?.authentication?.setupAvailable}
        <p role="alert">Local owner setup is not available for this instance yet. It must be provisioned locally before a password can be set.</p>
      {/if}
    {/if}
    <form onsubmit={(event) => { event.preventDefault(); void signIn(); }}>
      {#if !creatingPassword}
        <p id="instance-password-hint" class="password-hint">Password hint: {state?.authentication
          ? state.authentication.passwordHint || 'No hint has been set.' : 'Loading…'}</p>
      {/if}
      <label>Instance password
        <input type="password" bind:value={password} autocomplete={creatingPassword ? 'new-password' : 'current-password'}
          aria-describedby={creatingPassword ? undefined : 'instance-password-hint'}
          minlength={creatingPassword ? 12 : 1} maxlength="1024" required />
      </label>
      {#if creatingPassword}
        <label>Confirm password <input type="password" bind:value={repeatedPassword} autocomplete="new-password" maxlength="1024" required /></label>
        <label>Password hint (optional) <textarea bind:value={passwordHint} rows="2" maxlength="1000"></textarea></label>
        <p class="hint">Visible before sign-in. Use a reminder, not your password or other secret information.</p>
      {/if}
      <button disabled={busy || !state?.authentication || !password || (creatingPassword && (!state.authentication.setupAvailable || password.length < 12))}>
        {creatingPassword ? 'Set password and connect' : 'Sign in'}
      </button>
    </form>
    <button disabled={busy} onclick={() => void perform(async () => {})}>Refresh connection</button>
    <p class="hint">The password is exchanged for a private, expiring desktop session. It is not saved.
      This preview keeps the session only in memory; no Keychain or token-file import is required.
      Closing the app or signing out ends the local session.</p>
  {:else}
    <details>
      <summary>Connection · instance owner</summary>
      <p>Connected to <code>{state.environment}</code>. This session is kept in memory until sign-out or app restart.</p>
      <p class="hint">This preview protects host-task administration. Instance-wide API permissions and automatic
        container credentials are separate roadmap work.</p>
      <button disabled={busy} onclick={() => void perform(async () => {
        runnerActive = false;
        if (timer) clearInterval(timer);
        await window.workingMemory.signOutHostScripts();
        selectedJob = null;
        addingScript = false;
      })}>Sign out</button>
      <details ontoggle={(event) => {
        if (event.currentTarget.open) passwordHint = state?.authentication?.passwordHint ?? '';
      }}>
        <summary>Edit password hint</summary>
        <form onsubmit={(event) => { event.preventDefault(); void perform(() => window.workingMemory.setInstancePasswordHint(passwordHint)); }}>
          <label>Password hint (optional) <textarea bind:value={passwordHint} rows="2" maxlength="1000"></textarea></label>
          <p class="hint">Visible before sign-in. Use a reminder, not your password or other secret information.</p>
          <button disabled={busy}>Save password hint</button>
        </form>
        <p class="password-hint">Saved hint: {state?.authentication?.passwordHint || 'No hint has been set.'}</p>
      </details>
    </details>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if state}
    {#if !connectionOnly && state.features?.hostTasks === false}
      <p role="status">Host tasks is turned off. Enable it in Settings &gt; Features.</p>
    {:else if !connectionOnly && state.snapshot}
      <div class="actions">
        <button disabled={busy} onclick={() => { addingScript = !addingScript; }}>Add script</button>
        <button disabled={busy} onclick={() => void perform(async () => {})}>Refresh</button>
        {#if runnerActive}
          <button onclick={() => void stopRunner()}>Stop runner</button>
        {:else}
          <button disabled={busy || !state.snapshot.tasks.some(task => !task.revokedAt && task.hostId === state?.hostId)}
            onclick={startRunner}>Start runner</button>
        {/if}
      </div>
      <p role="status">Runner: {runnerActive ? (processing ? 'checking / running' : 'waiting for approved requests') : 'stopped'}.</p>
      {#if addingScript}
        <section class="task-detail" aria-label="Add script">
        <h2>Add script</h2>
        <label>Name <input bind:value={name} maxlength="100" /></label>
        <label>Description <input bind:value={description} maxlength="1000" /></label>
        <label>Allowed parameters (JSON)<textarea bind:value={parameters} rows="6"></textarea></label>
        <p>Scripts currently use Node.js CommonJS with built-in modules only.
          They run as your account, <strong>not in a sandbox</strong>. Changing a script requires a new approval.</p>
        <p>Types: <code>string</code> with <code>maxLength</code> and optional <code>enum</code>;
          <code>integer</code> with <code>minimum</code>/<code>maximum</code>; <code>boolean</code>.
          Add <code>"required": true</code> when needed. Unknown parameters are rejected.</p>
        <pre>module.exports = async function (parameters) &#123;
  return &#123; greeting: "Hello, " + parameters.name &#125;;
&#125;;</pre>
        <button disabled={busy || !name.trim()} onclick={() => void register(false)}>Choose script and review approval…</button>
        <details>
          <summary>Try a demo instead</summary>
          <p>The greeting demo returns a greeting and runtime information. It is only added if you approve it.</p>
          <button disabled={busy} onclick={() => void register(true)}>Add greeting demo…</button>
        </details>
        </section>
      {/if}
      <label class="revoked-filter"><input type="checkbox" bind:checked={showRevoked} /> Show revoked tasks</label>
      <ul class="task-list" aria-label="Registered host tasks">
        {#each visibleTasks as task (task.id)}
          <li>
            <button disabled={busy} class:selected={task.id === taskId} aria-pressed={task.id === taskId} onclick={() => {
              taskId = task.id;
              argumentsJson = '{}';
              selectedJob = null;
            }}>
              <strong>{task.name}</strong>
              <span>{task.description}</span>
              <small>Node.js · {task.hostId === state?.hostId ? 'this computer' : 'another computer'}{task.revokedAt ? ' · revoked' : ''}</small>
            </button>
          </li>
        {:else}
          <li class="empty-tasks">No tasks added. Choose Add script to register one. No demo tasks are installed automatically.</li>
        {/each}
      </ul>
      {#if selectedTask}
        <section class="task-detail" aria-label="Selected host task">
          <h2>{selectedTask.name}</h2>
          <p>{selectedTask.description}</p>
          <p>Runtime: Node.js · {selectedTask.hostId === state.hostId ? 'this computer' : 'another computer'}
            {selectedTask.revokedAt ? ' · revoked' : ''} · runs as your account, <strong>not in a sandbox</strong>.</p>
          {#if !canRunSelectedTask}<p>This task cannot run here: it is revoked or registered to another computer.</p>{/if}
          <details><summary>Parameters and approved version</summary>
            <pre>{JSON.stringify(selectedTask.parameters, null, 2)}</pre>
            <code>SHA-256: {selectedTask.definitionHash}</code>
          </details>
          <h3>Run a test</h3>
          <label>Parameters (JSON)<textarea bind:value={argumentsJson} rows="3"></textarea></label>
          <button disabled={busy || !canRunSelectedTask} onclick={() => void perform(async () => {
            const job = await window.workingMemory.testHostScript(taskId, JSON.parse(argumentsJson));
            if (job) selectedJob = job;
          })}>Review and queue one test…</button>
          <p class="hint">Start the runner to execute approved requests. It checks for work only while this tab is active.
            Switching tabs or closing this tab stops new claims; an in-progress run may finish.
            This version has a {selectedTask.timeoutMs / 1000}-second limit and returns up to 64 KiB of JSON. Console logs are not returned.</p>
          {#if selectedJob?.taskId === selectedTask.id}
            <h4>Selected run: {selectedJob.state}</h4>
            <pre>{selectedJob.error ?? selectedJob.resultJson ?? 'Queued — start the runner to execute.'}</pre>
          {/if}
          <details>
            <summary>App access</summary>
            <p>Choose a caller and approve temporary access to this version. A caller credential alone cannot run scripts.</p>
            <label>Caller
              <select bind:value={appId}>
                <option value="">Select a caller</option>
                {#each state.snapshot.apps.filter(app => !app.revokedAt) as app}
                  <option value={app.id}>{app.label} ({app.id})</option>
                {/each}
              </select>
            </label>
            <button disabled={busy || !canRunSelectedTask || !appId} onclick={() => void perform(() => window.workingMemory.grantHostScript({
              taskId, appId, expiresAt: Date.now() + 3600000,
            }))}>Review one-hour script grant…</button>
            <details><summary>Add a caller</summary>
              <label>Caller label <input bind:value={callerLabel} maxlength="100" /></label>
              <button disabled={busy || !callerLabel.trim()} onclick={() => void perform(() => window.workingMemory.exportHostTaskApp({
                label: callerLabel, instanceId: `host-script-${crypto.randomUUID()}`,
              }))}>Export new caller credential…</button>
            </details>
            {#each state.snapshot.grants.filter(grant => grant.taskId === selectedTask?.id) as grant}
              <p>Caller: {state.snapshot.apps.find(app => app.id === grant.appId)?.label ?? grant.appId} ·
                {grant.revokedAt ? 'revoked' : `expires ${new Date(grant.expiresAt).toLocaleString()}`}
                <button disabled={busy || !!grant.revokedAt} onclick={() => void perform(() => window.workingMemory.revokeHostScript(grant.id, true))}>Revoke grant…</button>
              </p>
            {:else}<p>No callers have access to this task.</p>{/each}
          </details>
          <details>
            <summary>Recent runs</summary>
            {#each state.snapshot.jobs.filter(job => job.taskId === selectedTask?.id) as job}
              <p>{job.appId ?? 'owner test'} · {job.state}
                <button disabled={busy} onclick={() => void perform(async () => {
                  selectedJob = await window.workingMemory.getHostScriptJob(job.id);
                })}>Inspect result</button>
              </p>
            {:else}<p>No runs yet.</p>{/each}
          </details>
          <details>
            <summary>Integration details</summary>
            <p>Authenticated MCP: <code>{state.environment}/host-tasks/v1/scripts/mcp</code>.
              Connect with the caller's bearer credential. Only granted script versions are exposed.
              Never give an agent your owner session or password. See the README for HTTP request examples.</p>
            <button disabled={busy || !!selectedTask.revokedAt} onclick={() => void perform(() => window.workingMemory.revokeHostScript(taskId, false))}>Revoke task version…</button>
          </details>
        </section>
      {/if}
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
  .task-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
  .task-list button { display: grid; gap: 4px; width: 100%; text-align: left; padding: 12px; white-space: normal; overflow-wrap: anywhere; }
  .task-list button.selected { border-color: var(--vscode-focusBorder, #b33771); }
  .task-list small { color: var(--vscode-descriptionForeground); }
  .task-detail { display: grid; gap: 10px; padding-block: 16px; border-top: 1px solid var(--vscode-widget-border, #bbb); }
  .revoked-filter { display: flex; align-items: center; gap: 6px; }
  .revoked-filter input { width: auto; }
  .empty-tasks { padding: 16px; border: 1px dashed var(--vscode-widget-border, #bbb); }
  .error { color: var(--vscode-errorForeground, #e55); }
  .hint { color: var(--vscode-descriptionForeground); }
  .password-hint { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
