<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { HostScriptDesktopState, ScriptJob, ScriptTask, ScriptDetails, ScriptVersion, HostScriptDraft } from '../shared/hostTasks';
  import { exampleScriptArguments, scriptParametersSchema, validateScriptArguments } from '../../../control-plane/src/hostScriptParameters';
  import HostScriptEditor from './HostScriptEditor.svelte';
  import HybridMarkdownEditor from './documents/HybridMarkdownEditor.svelte';

  let { connectionOnly = false, onConnectionChanged, taskId = '', onTaskRead, onTasksChanged,
    initialArgumentsJson = '', onArgumentsChanged, initialDraft = null, onDraftChanged, chatBusy = false,
    attachmentBaseUrl = '', onOpenLink }: {
    connectionOnly?: boolean; onConnectionChanged?: (connected: boolean) => void;
    taskId?: string;
    onTaskRead?: (task: ScriptTask) => void;
    onTasksChanged?: () => void;
    initialArgumentsJson?: string; onArgumentsChanged?: (value: string) => void;
    initialDraft?: HostScriptDraft | null; onDraftChanged?: (value: HostScriptDraft | null) => void;
    chatBusy?: boolean;
    attachmentBaseUrl?: string; onOpenLink?: (href: string) => void;
  } = $props();
  let state = $state<HostScriptDesktopState | null>(null);
  let error = $state('');
  let busy = $state(false);
  let mounted = true;
  let runnerActive = $state(false);
  let processing = $state(false);
  let timer: ReturnType<typeof setInterval> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshing = false;
  let refreshPromise: Promise<void> | null = null;
  let generation = 0;
  let editGeneration = 0;
  let pollError = $state('');
  let savingDraft = $state(false);
  let draftSave: Promise<ScriptVersion | undefined> | null = null;
  let details = $state<ScriptDetails | null>(null);
  let selectedVersion = $state(0);
  let source = $state('');
  let parametersJson = $state('');
  let draftDirty = $state(false);
  let testing = $state(false);
  let initialised = false;
  let chatLatestVersion: number | undefined;
  let argumentsEdited = !!untrack(() => initialArgumentsJson);
  const restoredDraft = untrack(() => initialDraft);
  let name = $state('');
  let description = $state('');
  let timeoutMs = $state<number | undefined>(10000);
  const tabs = [
    { id: 'settings', label: 'Settings' }, { id: 'code', label: 'Code and parameters' },
    { id: 'testing', label: 'Testing' }, { id: 'access', label: 'App access' },
    { id: 'caller', label: 'Add a caller' }, { id: 'runs', label: 'Recent runs' },
    { id: 'integration', label: 'Integration details' },
  ] as const;
  type TaskTab = typeof tabs[number]['id'];
  let tab = $state<TaskTab>('code');
  let appId = $state('');
  let argumentsJson = $state(untrack(() => initialArgumentsJson));
  let selectedJob = $state<ScriptJob | null>(null);
  let callerLabel = $state('My agent');
  let password = $state('');
  let repeatedPassword = $state('');
  let passwordHint = $state('');
  const creatingPassword = $derived(state?.authentication?.passwordConfigured === false);
  const selectedTask = $derived(state?.snapshot?.tasks.find(task => task.id === taskId) ?? null);
  const canRunSelectedTask = $derived(!!selectedTask && !selectedTask.revokedAt && selectedTask.hostId === state?.hostId);
  const currentVersion = $derived(details?.versions.find(version => version.version === selectedVersion));
  const isPublished = $derived(!draftDirty && selectedVersion === selectedTask?.publishedVersion);
  const result = $derived(selectedJob?.resultJson ? JSON.stringify(JSON.parse(selectedJob.resultJson), null, 2) : '');

  export async function prepareChat(): Promise<{ taskId: string; version: number }> {
    const version = await saveDraft();
    if (!mounted || !version) throw new Error('The host task editor is not ready.');
    chatLatestVersion = Math.max(...(details?.versions.map(item => item.version) ?? [version.version]));
    return { taskId, version: version.version };
  }

  export async function refreshFromChat(): Promise<void> {
    if (draftDirty || savingDraft) throw new Error('Chat changes are saved, but the editor has unsaved changes. Reopen the task to review both versions.');
    const edit = editGeneration;
    const previousLatest = chatLatestVersion ?? Math.max(...(details?.versions.map(item => item.version) ?? [selectedVersion]));
    generation++;
    const loaded = await window.workingMemory.getHostScript(taskId);
    if (!mounted || edit !== editGeneration) return;
    details = loaded;
    loadVersion(loaded.task.latestVersion > previousLatest
      ? loaded.versions[0] : loaded.versions.find(version => version.version === selectedVersion) ?? loaded.versions[0]);
    chatLatestVersion = loaded.task.latestVersion;
    await refresh();
    const job = state?.snapshot?.jobs.find(job => job.taskId === taskId && job.appId === null);
    if (job) {
      const result = await window.workingMemory.getHostScriptJob(job.id);
      if (mounted && edit === editGeneration) selectedJob = result;
    }
  }

  function loadVersion(version: ScriptVersion): void {
    selectedVersion = version.version;
    name = version.definition.name;
    description = version.definition.description;
    timeoutMs = version.definition.timeoutMs;
    source = version.definition.source;
    parametersJson = JSON.stringify(version.definition.parameters, null, 2);
    draftDirty = false;
    if (!argumentsEdited) {
      argumentsJson = JSON.stringify(exampleScriptArguments(version.definition.parameters), null, 2);
    }
  }
  function editDraft(): void {
    draftDirty = true;
    editGeneration++;
    onDraftChanged?.({ source, parametersJson, name, description, timeoutMs, baseVersion: selectedVersion });
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { void saveDraft().catch(cause => {
      if (mounted) error = cause instanceof Error ? cause.message : String(cause);
    }); }, 1000);
  }
  async function saveDraft(): Promise<ScriptVersion | undefined> {
    if (draftSave) { await draftSave; return saveDraft(); }
    if (!draftDirty || !currentVersion) return currentVersion;
    draftSave = persistDraft();
    try { return await draftSave; }
    finally { draftSave = null; }
  }
  async function persistDraft(): Promise<ScriptVersion> {
    if (!currentVersion) throw new Error('The script version is not loaded.');
    const parameters = scriptParametersSchema.parse(JSON.parse(parametersJson));
    if (timeoutMs === undefined) throw new Error('Enter a time limit between 1000 and 30000 ms.');
    const definition = { ...currentVersion.definition, name, description, timeoutMs, source, parameters };
    const currentEdit = editGeneration;
    savingDraft = true;
    generation++;
    try {
      const version = await window.workingMemory.saveHostScriptVersion(taskId, definition);
      if (!mounted) return version;
      if (details) {
        details = { ...details, task: { ...details.task, latestVersion: version.version,
          draftName: version.definition.name, draftDescription: version.definition.description },
        versions: [version, ...details.versions.filter(item => item.version !== version.version)] };
        onTaskRead?.(details.task);
      }
      if (currentEdit === editGeneration) {
        loadVersion(version);
        error = '';
        onDraftChanged?.(null);
      }
      return version;
    } finally { savingDraft = false; }
  }
  async function changeVersion(version: number): Promise<void> {
    await perform(async () => {
      await saveDraft();
      const next = details?.versions.find(item => item.version === version);
      if (next) { loadVersion(next); onDraftChanged?.(null); }
    });
  }
  function formatArguments(): void {
    try { argumentsJson = JSON.stringify(JSON.parse(argumentsJson), null, 2); onArgumentsChanged?.(argumentsJson); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  }
  async function test(): Promise<void> {
    await perform(async () => {
      const version = await saveDraft();
      if (!version) throw new Error('The script version is not loaded.');
      const parameters = validateScriptArguments(version.definition.parameters, JSON.parse(argumentsJson));
      argumentsJson = JSON.stringify(parameters, null, 2);
      onArgumentsChanged?.(argumentsJson);
      testing = true;
      selectedJob = null;
      try { selectedJob = await window.workingMemory.testHostScript(taskId, version.version, parameters); }
      finally { testing = false; }
    });
  }
  async function publish(): Promise<void> {
    await perform(async () => {
      const version = await saveDraft();
      if (!version || !selectedTask) throw new Error('The script version is not loaded.');
      const task = await window.workingMemory.publishHostScriptVersion(taskId, version.version, selectedTask.definitionHash);
      onTasksChanged?.();
    });
  }

  async function signIn(): Promise<void> {
    if (creatingPassword && password !== repeatedPassword) { error = 'The passwords do not match.'; return; }
    const value = password;
    password = '';
    repeatedPassword = '';
    await perform(() => window.workingMemory.signInHostScripts({
      password: value, setup: creatingPassword, ...(creatingPassword ? { passwordHint } : {}),
    }));
  }

  onMount(() => {
    void poll();
    pollTimer = setInterval(() => void poll(), 2000);
    const visible = () => { if (!document.hidden) void poll(); };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  });

  async function poll(): Promise<void> {
    if (!mounted || document.hidden || refreshing || busy || savingDraft || processing) return;
    try { await refresh(); }
    catch (cause) { if (mounted) pollError = cause instanceof Error ? cause.message : String(cause); }
  }

  async function refresh(): Promise<void> {
    if (!mounted) return;
    if (refreshPromise) { await refreshPromise; return refresh(); }
    refreshPromise = loadState();
    try { await refreshPromise; }
    finally { refreshPromise = null; }
  }
  async function loadState(): Promise<void> {
    refreshing = true;
    const current = generation;
    try {
      const result = await window.workingMemory.getHostScripts();
      if (!mounted || current !== generation) return;
      state = result;
      const task = state.snapshot?.tasks.find(task => task.id === taskId);
      if (task) {
        onTaskRead?.(task);
        if (!details || details.task.latestVersion !== task.latestVersion || details.task.publishedVersion !== task.publishedVersion) {
          const loaded = await window.workingMemory.getHostScript(taskId);
          if (!mounted || current !== generation) return;
          details = loaded;
          if (!initialised) {
            initialised = true;
            loadVersion(loaded.versions.find(version => version.version === restoredDraft?.baseVersion) ?? loaded.versions[0]);
            if (restoredDraft) {
              source = restoredDraft.source; parametersJson = restoredDraft.parametersJson;
              name = restoredDraft.name ?? name; description = restoredDraft.description ?? description;
              timeoutMs = restoredDraft.timeoutMs ?? timeoutMs; editDraft();
            }
          }
          onTaskRead?.(details?.task ?? task);
        }
      }
      if (selectedJob) {
        const job = await window.workingMemory.getHostScriptJob(selectedJob.id);
        if (mounted && current === generation) selectedJob = job;
      }
      if (mounted && current === generation) {
        pollError = '';
        onConnectionChanged?.(state.credentialReady);
      }
    } finally { refreshing = false; }
  }
  async function perform(action: () => Promise<unknown>): Promise<void> {
    generation++;
    busy = true;
    error = '';
    try { await action(); await refresh(); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { busy = false; }
  }
  function navigateTabs(event: KeyboardEvent, index: number): void {
    let next: number;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    tab = tabs[next].id;
    const buttons = (event.currentTarget as HTMLButtonElement).parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next].focus();
  }
  async function tick(): Promise<void> {
    if (!runnerActive || processing || busy || savingDraft || chatBusy) return;
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
    mounted = false;
    runnerActive = false;
    if (timer) clearInterval(timer);
    if (pollTimer) clearInterval(pollTimer);
    if (saveTimer) clearTimeout(saveTimer);
    generation++;
  });
</script>

<section class="scripts" aria-label="Approved host tasks">
  {#if !state}
    <p role="status">Loading task…</p>
  {:else if !state.credentialReady}
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
    <p class="hint">The password is exchanged for a private, expiring desktop session. It is not saved.
      This preview keeps the session only in memory; no Keychain or token-file import is required.
      Closing the app or signing out ends the local session.</p>
  {/if}
  {#if error || pollError}<p class="error" role="alert">{error || pollError}</p>{/if}
  {#if state}
    {#if !connectionOnly && state.features?.hostTasks === false}
      <p role="status">Host tasks is turned off. Enable it in Settings &gt; Features.</p>
    {:else if !connectionOnly && state.snapshot}
      {#if selectedTask}
        <section class="task-detail" aria-label="Selected host task">
          <input class="task-title" aria-label="Task title" placeholder="Untitled task" value={name} maxlength="100"
            disabled={busy || chatBusy || !canRunSelectedTask || !currentVersion}
            oninput={(event) => { name = event.currentTarget.value; editDraft(); }} />
          {#if !canRunSelectedTask}<p>This task cannot run here: it is revoked or registered to another computer.</p>{/if}
          {#if details && currentVersion}
            <div class="version-actions">
              <label>Version
                <select aria-label="Task version" value={selectedVersion} disabled={busy || savingDraft || chatBusy}
                  onchange={(event) => void changeVersion(Number(event.currentTarget.value))}>
                  {#each details.versions as version (version.version)}
                    <option value={version.version}>v{version.version}{version.version === selectedTask.publishedVersion ? ' · Published' : ' · Draft'}</option>
                  {/each}
                </select>
              </label>
              <span role="status">{savingDraft ? 'Saving draft…' : draftDirty ? 'Unsaved draft' : isPublished ? 'Published' : `Draft v${selectedVersion}`}</span>
              <button disabled={busy || savingDraft || processing || chatBusy || !canRunSelectedTask || isPublished} onclick={() => void publish()}>Publish</button>
            </div>
            <div class="settings-tabs task-tabs" role="tablist" aria-label="Host task sections">
              {#each tabs as item, index}
                <button role="tab" id={`host-task-tab-${item.id}`} aria-controls={`host-task-panel-${item.id}`}
                  aria-selected={tab === item.id} tabindex={tab === item.id ? 0 : -1}
                  onclick={() => { tab = item.id; }} onkeydown={(event) => navigateTabs(event, index)}>{item.label}</button>
              {/each}
            </div>
            <div class="task-panel" role="tabpanel" tabindex="0" id={`host-task-panel-${tab}`} aria-labelledby={`host-task-tab-${tab}`}>
            {#if tab === 'settings'}
              <h3>Description</h3>
              <HybridMarkdownEditor value={description} label="Task description (Markdown live preview)"
                disabled={busy || chatBusy || !canRunSelectedTask} {attachmentBaseUrl} {onOpenLink}
                onInput={(value) => { description = value; editDraft(); }} />
              <label>Time limit (ms) <input type="number" value={timeoutMs} min="1000" max="30000" step="1000"
                disabled={busy || chatBusy || !canRunSelectedTask} oninput={(event) => {
                  timeoutMs = event.currentTarget.value === '' ? undefined : event.currentTarget.valueAsNumber; editDraft();
                }} /></label>
              <p class="hint">Node.js · {selectedTask.hostId === state.hostId ? 'this computer' : 'another computer'}.
                Runs as your account, <strong>not in a sandbox</strong>.</p>
              <button disabled={busy || chatBusy || !!selectedTask.revokedAt} onclick={() => void perform(async () => {
                await saveDraft();
                await window.workingMemory.revokeHostScript(taskId, false);
                if (mounted) onTasksChanged?.();
              })}>Revoke task…</button>
            {:else if tab === 'code'}
              <h3>Code</h3>
              <HostScriptEditor label="Script code" value={source} disabled={busy || chatBusy || !canRunSelectedTask}
                onInput={(value) => { source = value; editDraft(); }} />
              <h3>Parameters</h3>
              <HostScriptEditor label="Parameter schema" language="json" value={parametersJson} minHeight={100}
                disabled={busy || chatBusy || !canRunSelectedTask} onInput={(value) => { parametersJson = value; editDraft(); }} />
              <p class="hint">Edits save as drafts. Publish makes this version available to callers.</p>
            {:else if tab === 'testing'}
              <h3>Test input</h3>
              <HostScriptEditor label="Test input" language="json" value={argumentsJson} minHeight={80}
                disabled={busy || chatBusy || !canRunSelectedTask} onInput={(value) => {
                  argumentsEdited = true; argumentsJson = value; onArgumentsChanged?.(value);
                }} onBlur={formatArguments} />
              <div class="actions">
                <button disabled={busy || savingDraft || processing || chatBusy || !canRunSelectedTask} onclick={() => void test()}>Test</button>
                {#if testing}<span role="status">Running test…</span>{/if}
              </div>
              <p class="hint">Runs this version on your computer. {currentVersion.definition.timeoutMs / 1000}s limit ·
                64 KiB JSON result · console logs are not returned.</p>
              {#if selectedJob?.taskId === selectedTask.id}
                <h3>Result · v{selectedJob.version} · {selectedJob.state}</h3>
                <pre class:error={!!selectedJob.error} role={selectedJob.error ? 'alert' : 'status'}>{selectedJob.error ?? (result || selectedJob.state)}</pre>
              {/if}
            {:else if tab === 'access'}
            <div class="actions">
              {#if runnerActive}
                <button onclick={() => void stopRunner()}>Stop runner</button>
              {:else}
                <button disabled={busy || !canRunSelectedTask} onclick={startRunner}>Start runner</button>
              {/if}
              <span role="status">Runner: {runnerActive ? (processing ? 'checking / running' : 'waiting for approved requests') : 'stopped'}.</span>
            </div>
            <p class="hint">Processes approved requests for this computer while this document tab is active. Tests do not need it.</p>
            <p>Caller access uses published v{selectedTask.publishedVersion}, not an unpublished draft. A caller credential alone cannot run scripts.</p>
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
            {#each state.snapshot.grants.filter(grant => grant.taskId === selectedTask?.id) as grant}
              <p>Caller: {state.snapshot.apps.find(app => app.id === grant.appId)?.label ?? grant.appId} ·
                {grant.revokedAt ? 'revoked' : `expires ${new Date(grant.expiresAt).toLocaleString()}`}
                <button disabled={busy || !!grant.revokedAt} onclick={() => void perform(() => window.workingMemory.revokeHostScript(grant.id, true))}>Revoke grant…</button>
              </p>
            {:else}<p>No callers have access to this task.</p>{/each}
            {:else if tab === 'caller'}
              <p class="hint">Create a caller credential, then grant this task under App access.</p>
              <label>Caller label <input bind:value={callerLabel} maxlength="100" /></label>
              <button disabled={busy || !callerLabel.trim()} onclick={() => void perform(() => window.workingMemory.exportHostTaskApp({
                label: callerLabel, instanceId: `host-script-${crypto.randomUUID()}`,
              }))}>Export new caller credential…</button>
            {:else if tab === 'runs'}
            {#each state.snapshot.jobs.filter(job => job.taskId === selectedTask?.id) as job}
              <p>{job.appId ?? 'owner test'} · v{job.version} · {job.state}
                <button disabled={busy} onclick={() => void perform(async () => {
                  selectedJob = await window.workingMemory.getHostScriptJob(job.id);
                  tab = 'testing';
                })}>Inspect result</button>
              </p>
            {:else}<p>No runs yet.</p>{/each}
            {:else if tab === 'integration'}
            <p>Authenticated MCP: <code>{state.environment}/host-tasks/v1/scripts/mcp</code>.
              Connect with the caller's bearer credential. Only granted script versions are exposed.
              Never give an agent your owner session or password. See the README for HTTP request examples.</p>
            {/if}
            </div>
          {:else}<p role="status">Loading task…</p>{/if}
        </section>
      {:else if taskId}
        <p role="alert">This host task is no longer registered.</p>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .scripts { display: grid; gap: 10px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .version-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: end; }
  .version-actions label { min-width: 160px; }
  .version-actions span { align-self: center; color: var(--vscode-descriptionForeground); font-size: 12px; }
  .version-actions button { margin-left: auto; }
  label { display: grid; gap: 4px; }
  input, select, textarea { width: 100%; box-sizing: border-box; }
  textarea, pre, code { font-family: var(--vscode-editor-font-family, monospace); }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; }
  .task-detail { display: grid; gap: 10px; min-width: 0; padding-block: 8px; }
  .task-panel { display: grid; gap: 12px; min-width: 0; }
  .task-tabs { flex-wrap: wrap; margin: 4px 0; }
  .task-title { font-size: 1.5em; font-weight: 600; padding: 4px 8px; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px; }
  .task-title:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .task-detail h3, .task-detail p { margin: 0; }
  .task-detail h3 { margin-top: 8px; font-size: 13px; }
  .error { color: var(--vscode-errorForeground, #e55); }
  .hint { color: var(--vscode-descriptionForeground); }
  .password-hint { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
