<script lang="ts">
  import { onMount } from 'svelte';
  import type { EmbeddingAction, EmbeddingDashboard } from '../../shared/embeddings';
  import { startVisiblePolling } from '../visiblePolling';

  let snapshot = $state<EmbeddingDashboard | null>(null);
  let error = $state('');
  let busy = $state(false);
  let refreshing = $state(false);
  let retention = $state('always');
  $effect(() => { retention = snapshot?.idleTimeoutMinutes == null ? 'always' : String(snapshot.idleTimeoutMinutes); });
  let active = true;
  let generation = 0;
  async function refresh(): Promise<void> {
    if (refreshing || busy) return;
    refreshing = true;
    const current = generation;
    try {
      const value = await window.workingMemory.getEmbeddingDashboard();
      if (active && current === generation) { snapshot = value; error = ''; }
    } catch (cause) {
      if (active && current === generation) error = cause instanceof Error ? cause.message : String(cause);
    } finally { refreshing = false; }
  }
  onMount(() => {
    const stop = startVisiblePolling(refresh, 2000);
    return () => { active = false; stop(); };
  });
  async function act(action: EmbeddingAction): Promise<void> {
    generation++;
    busy = true;
    error = '';
    try {
      const value = await window.workingMemory.setEmbeddingAction(action);
      if (active) snapshot = value;
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; }
  }
  async function setRetention(value: string): Promise<void> {
    generation++;
    busy = true;
    error = '';
    try {
      const next = await window.workingMemory.setEmbeddingRetention(value === 'always' ? null : Number(value));
      if (active) snapshot = next;
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
      retention = snapshot?.idleTimeoutMinutes == null ? 'always' : String(snapshot.idleTimeoutMinutes);
    } finally { busy = false; }
  }
  const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
  const date = (at: number | null) => at ? new Date(at).toLocaleString() : 'Not yet';
</script>

<section aria-label="Embeddings dashboard" class="embeddings-dashboard">
  <h2>Embeddings</h2>
  <p>Local meaning-based Search and Related topics. Each enabled environment indexes WM documents in its container,
    even when this desktop is closed. The bundled host inference service starts at sign-in.</p>
  {#if error || snapshot?.error}<p role="alert">{error || snapshot?.error}</p>{/if}
  {#if snapshot}
    <p><strong>Status:</strong> {snapshot.phase}
      {#if snapshot.phase === 'downloading'}
        &middot; {mib(snapshot.downloadBytes)} / {mib(snapshot.downloadTotal)}
        <progress max={snapshot.downloadTotal} value={snapshot.downloadBytes} aria-label="Model download progress"></progress>
      {/if}
    </p>
    <div class="controls">
      {#if snapshot.enabled}
        <button disabled={busy} onclick={() => void act(snapshot?.paused ? 'resume' : 'pause')}>
          {snapshot.paused ? 'Resume' : 'Pause'}
        </button>
        {#if snapshot.error}
          <button disabled={busy} onclick={() => void act('retry')}>Retry</button>
        {/if}
      {/if}
      <button disabled={refreshing} onclick={() => void refresh()}>Refresh</button>
    </div>
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
</section>

<style>
  .embeddings-dashboard { max-width: 760px; }
  .controls { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
  dl { display: grid; grid-template-columns: minmax(140px, 1fr) 2fr; gap: 10px 16px; }
  dt { font-weight: 600; } dd { margin: 0; overflow-wrap: anywhere; }
  progress { display: block; width: 100%; margin-top: 8px; }
</style>
