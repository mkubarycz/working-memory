<script lang="ts">
  import { onMount } from 'svelte';
  import type { EmbeddingAction, EmbeddingDashboard, EmbeddingDiagnostics } from '../../shared/embeddings';
  import { startVisiblePolling } from '../visiblePolling';

  let snapshot = $state<EmbeddingDashboard | null>(null);
  let diagnostics = $state<EmbeddingDiagnostics | null>(null);
  let diagnosticsError = $state('');
  let error = $state('');
  let operationError = $state('');
  let busy = $state(false);
  let refreshing = $state(false);
  let diagnosticsRefreshing = $state(false);
  let retention = $state('always');
  $effect(() => { retention = snapshot?.idleTimeoutMinutes == null ? 'always' : String(snapshot.idleTimeoutMinutes); });
  let active = true;
  let generation = 0;
  async function refreshDashboard(): Promise<void> {
    if (!active || refreshing || busy) return;
    refreshing = true;
    const current = generation;
    try {
      const value = await window.workingMemory.getEmbeddingDashboard();
      if (active && current === generation) {
        snapshot = value;
        error = '';
      }
    } catch (cause) {
      if (active && current === generation) error = cause instanceof Error ? cause.message : String(cause);
    } finally { refreshing = false; }
  }
  async function refreshDiagnostics(): Promise<void> {
    if (!active || diagnosticsRefreshing) return;
    diagnosticsRefreshing = true;
    const current = generation;
    try {
      const value = await window.workingMemory.getEmbeddingDiagnostics();
      if (active && current === generation) { diagnostics = value; diagnosticsError = ''; }
    } catch (cause) {
      if (active && current === generation) diagnosticsError = cause instanceof Error ? cause.message : String(cause);
    } finally { diagnosticsRefreshing = false; }
  }
  function refresh(): void {
    void refreshDashboard();
    void refreshDiagnostics();
  }
  onMount(() => {
    const stopDashboard = startVisiblePolling(refreshDashboard, 2000);
    const stopDiagnostics = startVisiblePolling(refreshDiagnostics, 2000);
    return () => { active = false; stopDashboard(); stopDiagnostics(); };
  });
  async function act(action: EmbeddingAction): Promise<void> {
    generation++;
    busy = true;
    error = '';
    operationError = '';
    try {
      const value = await window.workingMemory.setEmbeddingAction(action);
      if (active) snapshot = value;
    } catch (cause) {
      if (active) operationError = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; void refresh(); }
  }
  async function setRetention(value: string): Promise<void> {
    generation++;
    busy = true;
    error = '';
    operationError = '';
    try {
      const next = await window.workingMemory.setEmbeddingRetention(value === 'always' ? null : Number(value));
      if (active) snapshot = next;
    } catch (cause) {
      if (active) operationError = cause instanceof Error ? cause.message : String(cause);
      retention = snapshot?.idleTimeoutMinutes == null ? 'always' : String(snapshot.idleTimeoutMinutes);
    } finally { busy = false; }
  }
  const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
  const date = (at: number | null) => at ? new Date(at).toLocaleString() : 'Not yet';
  const failed = $derived(!!error || !!operationError || !!snapshot?.error || snapshot?.phase === 'error'
    || !!diagnosticsError || !!diagnostics?.service.error);
</script>

<section aria-label="Embeddings dashboard" class="embeddings-dashboard">
  <h2>Embeddings</h2>
  <p>Local meaning-based Search and Related topics. Each enabled environment indexes WM documents in its container,
    even when this desktop is closed. The bundled host inference service starts at sign-in.</p>
  {#if operationError}<p role="alert">{operationError}</p>{/if}
  {#if error || snapshot?.error}<p role="alert">{error || snapshot?.error}</p>{/if}
  {#if snapshot?.phase === 'error' && !snapshot.error && !error && !operationError}
    <p role="alert">Indexing reports an error without details. Check the host service and error log below, then Retry.</p>
  {/if}
  <div class="controls">
    {#if snapshot?.enabled}
      <button disabled={busy} onclick={() => void act(snapshot?.paused ? 'resume' : 'pause')}>
        {snapshot.paused ? 'Resume' : 'Pause'}
      </button>
      {#if failed || (diagnostics && (diagnostics.service.state !== 'running'
        || diagnostics.service.version !== diagnostics.service.expectedVersion))}
        <button disabled={busy} onclick={() => void act('retry')}>Retry</button>
      {/if}
    {/if}
    <button disabled={(refreshing && diagnosticsRefreshing) || busy} onclick={() => refresh()}>Refresh</button>
  </div>
  {#if snapshot}
    <p><strong>Status:</strong> {snapshot.phase}
      {#if snapshot.phase === 'downloading'}
        &middot; {mib(snapshot.downloadBytes)} / {mib(snapshot.downloadTotal)}
        <progress max={snapshot.downloadTotal} value={snapshot.downloadBytes} aria-label="Model download progress"></progress>
      {/if}
    </p>
    <label>Keep model loaded
      <select aria-label="Model retention" disabled={busy}
        bind:value={retention}
        onchange={event => void setRetention(event.currentTarget.value)}>
        <option value="always">Until the host service stops (default)</option>
        <option value="1">1 minute idle</option>
        <option value="10">10 minutes idle</option>
        <option value="30">30 minutes idle</option>
        <option value="60">60 minutes idle</option>
        {#if snapshot.idleTimeoutMinutes !== null && ![1, 10, 30, 60].includes(snapshot.idleTimeoutMinutes)}
          <option value={String(snapshot.idleTimeoutMinutes)}>{snapshot.idleTimeoutMinutes} minutes idle</option>
        {/if}
      </select>
    </label>
    <p>Keeping the loaded model warm avoids repeated startup delays but holds about 1.1 GiB of memory.
      This setting is saved for this computer's shared host service and applies across local environments.
      It does not enable Embeddings or start indexing.</p>
    {#if !snapshot.enabled}
      <p>Enable Embeddings in Settings &gt; Features. Enabling downloads a verified {mib(snapshot.downloadTotal)} model from Hugging Face once.
        Topic content stays local. Cached models are retained when disabled.</p>
    {/if}
    <dl>
      <dt>Execution backend</dt><dd>{snapshot.backend ?? 'Not loaded'}</dd>
      <dt>Document coverage</dt><dd>{snapshot.stats
        ? `${snapshot.stats.indexed} / ${snapshot.stats.total} indexed; ${snapshot.stats.pending} pending`
        : 'Index unavailable'}</dd>
      <dt>Last indexing success</dt><dd>{date(snapshot.stats?.lastIndexedAt ? snapshot.stats.lastIndexedAt * 1000 : null)}</dd>
      <dt>Last document inference</dt><dd>{snapshot.lastInferenceMs === null ? 'Not measured' : `${snapshot.lastInferenceMs.toFixed(0)} ms`}</dd>
      <dt>Helper memory (RSS)</dt><dd>{snapshot.rssBytes === null ? 'Not loaded' : mib(snapshot.rssBytes)}</dd>
      <dt>Stored passage vectors</dt><dd>{snapshot.stats ? mib(snapshot.stats.vectorBytes) : 'Unavailable'} (disk; excludes database overhead)</dd>
      <dt>Model version</dt><dd>{snapshot.model}</dd>
    </dl>
    {#if snapshot.warning}<p role="status">{snapshot.warning}</p>{/if}
    {#if snapshot.stats?.limited}
      <p role="status">{snapshot.stats.limited} documents exceed V1's 32,000-character body coverage. Their later content is not indexed.</p>
    {/if}
    <p>Pause stops indexing for this environment. Model unloading follows the retention setting above.
      Indexing needs an awake computer, a signed-in session and a running container.
      Pending includes new or changed documents. Search requires enabled Embeddings and complete indexing.
      An empty queue means the index is caught up, not that every suggested relationship is correct.</p>
  {:else if !error}<p role="status">Loading embeddings diagnostics...</p>{/if}
  <details class="service-troubleshooting" open={failed}>
    <summary>Service troubleshooting and error log</summary>
    {#if diagnosticsError}<p role="alert">Local service diagnostics failed: {diagnosticsError}</p>{/if}
    {#if diagnostics}
      <dl>
        <dt>Host service (this computer)</dt><dd>{diagnostics.service.state} &middot; 127.0.0.1:7716</dd>
        <dt>Host phase / backend</dt><dd>{diagnostics.service.phase ?? 'Unavailable'} / {diagnostics.service.backend ?? 'Not loaded'}</dd>
        {#if diagnostics.service.endpoints?.length}
          <dt>WSL inference endpoints</dt><dd>{diagnostics.service.endpoints.join(', ')}</dd>
        {/if}
        <dt>Service version</dt><dd>{diagnostics.service.version ?? 'Unavailable'}</dd>
        <dt>Installed version</dt><dd>{diagnostics.service.expectedVersion}</dd>
        <dt>Service log location</dt><dd>{diagnostics.logPath}</dd>
      </dl>
      {#if diagnostics.service.error}<p role="alert">Host service: {diagnostics.service.error}</p>{/if}
      {#if diagnostics.service.version && diagnostics.service.version !== diagnostics.service.expectedVersion}
        <p role="alert">The host service is running an older or different build. Retry replaces it with the installed build.</p>
      {/if}
      <p>If the host is running but indexing reports a connection error, check Docker connectivity to
        the configured inference endpoint. On Windows/Podman, Retry discovers a private WSL endpoint automatically;
        if connectivity is still refused, check Windows firewall policy for the WSL virtual interface.
        If the host is unreachable, Retry repairs its sign-in service.
        On Windows, check Task Scheduler &gt; Working Memory Embeddings; NPU errors may require an Intel NPU driver update.
        Missing helper or DLL errors require reinstalling the current Windows build.</p>
      <p>Not loaded alone is normal before first inference or after unloading. Retry also resumes indexing for this environment.
        The log is shared by this computer's local environments; it shows the latest 100 lines (up to 32 KiB).
        Credentials are redacted; document passages are not logged.</p>
      {#if diagnostics.log}
        <pre aria-label="Embedding service error log">{diagnostics.log}</pre>
      {:else}
        <p role="status">{diagnostics.logExists ? 'The service log is empty.' : 'No service log has been created yet.'}
          Retry records installation and early startup failures here, even if the inference service cannot start.</p>
      {/if}
    {:else if !diagnosticsError}<p role="status">Loading local service diagnostics...</p>{/if}
  </details>
</section>

<style>
  .embeddings-dashboard { max-width: 760px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
  dl { display: grid; grid-template-columns: minmax(140px, 1fr) 2fr; gap: 10px 16px; }
  dt { font-weight: 600; } dd { margin: 0; overflow-wrap: anywhere; }
  progress { display: block; width: 100%; margin-top: 8px; }
  summary { cursor: pointer; font-weight: 600; }
  pre { max-height: 320px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
