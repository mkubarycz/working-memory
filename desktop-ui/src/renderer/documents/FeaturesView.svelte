<script lang="ts">
  import { onMount } from 'svelte';
  import type { InstanceFeatures } from '../../../../control-plane/src/instanceFeatures';
  import type { EmbeddingDashboard } from '../../shared/embeddings';

  let { onChanged }: { onChanged: (features: InstanceFeatures) => void } = $props();
  let features = $state<InstanceFeatures | null>(null);
  let enabled = $state(false);
  let searchEnabled = $state(false);
  let embeddings = $state<EmbeddingDashboard | null>(null);
  let embeddingsEnabled = $state(false);
  let busy = $state(false);
  let error = $state('');
  let pollError = $state('');
  let embeddingsPollError = $state('');
  let active = false;
  let refreshing = false;
  let generation = 0;

  async function load(): Promise<void> {
    if (!active || refreshing || busy) return;
    refreshing = true;
    const current = generation;
    try {
      const [loaded, embeddingStatus] = await Promise.allSettled([
        window.workingMemory.getInstanceFeatures(),
        window.workingMemory.getEmbeddingDashboard(),
      ]);
      if (!active || current !== generation) return;
      if (loaded.status === 'fulfilled') {
        features = loaded.value;
        enabled = features.hostTasks;
        searchEnabled = features.search;
        pollError = '';
        onChanged(features);
      } else pollError = loaded.reason instanceof Error ? loaded.reason.message : String(loaded.reason);
      if (embeddingStatus.status === 'fulfilled') {
        embeddings = embeddingStatus.value;
        embeddingsEnabled = embeddings.enabled;
        embeddingsPollError = embeddings.error ?? '';
      } else {
        embeddings = null;
        embeddingsPollError = embeddingStatus.reason instanceof Error ? embeddingStatus.reason.message : String(embeddingStatus.reason);
      }
    } catch (cause) {
      if (active && current === generation) pollError = cause instanceof Error ? cause.message : String(cause);
    } finally { refreshing = false; }
  }
  async function toggleEmbeddings(requested: boolean): Promise<void> {
    if (!active || busy || !embeddings) return;
    busy = true;
    generation += 1;
    error = '';
    try {
      const saved = await window.workingMemory.setEmbeddingAction(requested ? 'enable' : 'disable');
      if (active) embeddings = saved;
    } catch (cause) { if (active) error = cause instanceof Error ? cause.message : String(cause); }
    finally {
      embeddingsEnabled = embeddings?.enabled ?? false;
      busy = false;
    }
  }
  async function toggle(feature: keyof InstanceFeatures, requested: boolean): Promise<void> {
    if (!active || busy || !features) return;
    busy = true;
    generation += 1;
    error = '';
    try {
      const saved = await window.workingMemory.setInstanceFeatures({ [feature]: requested });
      if (!active) return;
      features = saved;
      onChanged(features);
    } catch (cause) { if (active) error = cause instanceof Error ? cause.message : String(cause); }
    finally {
      enabled = features?.hostTasks ?? false;
      searchEnabled = features?.search ?? false;
      busy = false;
    }
  }
  onMount(() => {
    active = true;
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => { active = false; generation += 1; clearInterval(timer); };
  });
</script>

<section aria-label="Feature flags">
  <h2>Features</h2>
  <p>Features apply to the selected instance and all its clients.</p>
  <table>
    <thead><tr><th>Feature name</th><th>Short description</th><th>Enabled</th></tr></thead>
    <tbody><tr>
      <th scope="row">Host tasks <small>Experimental</small></th>
      <td>Run owner-approved scripts on this computer with controlled agent access.</td>
      <td>
        <input class="feature-switch" type="checkbox" role="switch" aria-label="Host tasks" bind:checked={enabled}
          disabled={!features || busy} onchange={(event) => void toggle('hostTasks', event.currentTarget.checked)} />
      </td>
    </tr>
    <tr>
      <th scope="row">Working Memory search <small>Experimental</small></th>
      <td>Find and summarize documents using AI and registered apps' read-only tools.</td>
      <td>
        <input class="feature-switch" type="checkbox" role="switch" aria-label="Working Memory search" bind:checked={searchEnabled}
          disabled={!features || busy} onchange={(event) => void toggle('search', event.currentTarget.checked)} />
      </td>
    </tr>
    <tr>
      <th scope="row">Embeddings <small>Experimental</small></th>
      <td>Enable semantic Search and Related topics with local background indexing. Search waits for complete document indexing. Monitor progress in Diagnostics &gt; Embeddings.</td>
      <td>
        <input class="feature-switch" type="checkbox" role="switch" aria-label="Embeddings" bind:checked={embeddingsEnabled}
          disabled={!features || !embeddings || busy || (!searchEnabled && !embeddingsEnabled)}
          onchange={(event) => void toggleEmbeddings(event.currentTarget.checked)} />
      </td>
    </tr></tbody>
  </table>
  <p class="hint">Turning off Host tasks hides its UI and blocks new requests. Existing scripts, permissions, and history are retained.</p>
  <p class="hint">Search is off by default. Turning it off hides Search and stops its requests; documents and workstream memberships are retained.</p>
  <p class="hint">Embeddings requires Working Memory search. Enabling installs the bundled background service and downloads
    a verified 87 MiB model once. Topic content stays local. Disabling stops this instance's indexing but retains cached models and vectors.</p>
  {#if error || pollError || embeddingsPollError}<p role="alert">{error || pollError || embeddingsPollError}</p>{/if}
</section>

<style>
  section { display: grid; gap: 12px; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 12px; border-bottom: 1px solid var(--vscode-panel-border, #444); vertical-align: middle; }
  th:last-child, td:last-child { text-align: center; width: 80px; }
  small { display: block; font-weight: normal; color: var(--desktop-chat-muted); }
  .hint { font-size: 12px; color: var(--desktop-chat-muted); }
  .feature-switch {
    appearance: none; box-sizing: border-box; display: inline-block; vertical-align: middle;
    width: 40px; height: 24px; padding: 0; margin: 0;
    border: 1px solid transparent; border-radius: 999px; background: #8f8992;
    position: relative; cursor: pointer; transition: background-color 140ms ease;
  }
  .feature-switch::before {
    content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
    border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #0003;
    transition: transform 140ms ease;
  }
  .feature-switch:checked { background: var(--desktop-accent-strong, #bd1f66); }
  .feature-switch:checked::before { transform: translateX(16px); }
  .feature-switch:focus { box-shadow: none; }
  .feature-switch:focus-visible { outline: 2px solid var(--vscode-focusBorder, #bd1f66); outline-offset: 3px; }
  .feature-switch:disabled { opacity: 0.5; cursor: default; }
  @media (prefers-reduced-motion: reduce) {
    .feature-switch, .feature-switch::before { transition: none; }
  }
</style>
