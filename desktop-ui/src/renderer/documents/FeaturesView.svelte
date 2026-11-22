<script lang="ts">
  import { onMount } from 'svelte';
  import type { InstanceFeatures } from '../../../../control-plane/src/instanceFeatures';
  import type { EmbeddingDashboard } from '../../shared/embeddings';
  import type { FeatureBugReportInput } from '../../shared/contracts';
  import ReportBugDialog from '../ReportBugDialog.svelte';

  let { onChanged, onOpenObservability }: {
    onChanged: (features: InstanceFeatures) => void; onOpenObservability?: () => Promise<void>;
  } = $props();
  let features = $state<InstanceFeatures | null>(null);
  let enabled = $state(false);
  let searchEnabled = $state(false);
  let observabilityEnabled = $state(false);
  let recoveryAppId = $state<string | null>(null);
  let embeddings = $state<EmbeddingDashboard | null>(null);
  let embeddingsEnabled = $state(false);
  let busy = $state(false);
  let error = $state('');
  let pollError = $state('');
  let embeddingsPollError = $state('');
  let notice = $state('');
  let operation = $state('');
  let requestedChange = $state<FeatureBugReportInput['failure']['requested']>();
  let reporting = $state<FeatureBugReportInput['failure'] | null>(null);
  const displayedError = $derived(error || pollError || embeddingsPollError);
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
        observabilityEnabled = features.observability ?? false;
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
    notice = '';
    operation = 'embeddings:action';
    requestedChange = { feature: 'embeddings', enabled: requested };
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
    notice = '';
    recoveryAppId = null;
    operation = 'instance:set-features';
    requestedChange = { feature, enabled: requested };
    try {
      const saved = await window.workingMemory.setInstanceFeatures({ [feature]: requested });
      if (!active) return;
      features = saved;
      onChanged(features);
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
      if (feature === 'observability' && active
        && /ownership conflict|belongs to another container provider or connection|selected connection differs|ownership recovery was interrupted/i.test(error)) {
        try {
          const apps = (await window.workingMemory.listContainerApps()).filter(app => app.nativeSurface === 'observability');
          const status = apps.length === 1 ? await window.workingMemory.inspectContainerApp(apps[0].id) : null;
          if (active) recoveryAppId = status?.recoveryAvailable ? status.id : null;
        } catch (discoveryError) {
          if (active) error += ` Recovery discovery failed: ${discoveryError instanceof Error ? discoveryError.message : String(discoveryError)}`;
        }
      }
    } finally {
      enabled = features?.hostTasks ?? false;
      searchEnabled = features?.search ?? false;
      observabilityEnabled = features?.observability ?? false;
      busy = false;
    }
  }
  async function recoverObservability(): Promise<void> {
    if (!active || busy || !recoveryAppId) return;
    busy = true;
    generation += 1;
    error = '';
    notice = '';
    operation = 'container:recover';
    requestedChange = undefined;
    try {
      const status = await window.workingMemory.recoverContainerApp(recoveryAppId);
      if (!active) return;
      recoveryAppId = status.recoveryAvailable ? status.id : null;
      error = status.error ?? '';
      if (!status.error) notice = 'Recovery check finished. Enable Observability to retry setup.';
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; }
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
      <td>Enable semantic Search and Related topics with local background indexing. Requires Working Memory search.</td>
      <td>
        <input class="feature-switch" type="checkbox" role="switch" aria-label="Embeddings" bind:checked={embeddingsEnabled}
          disabled={!features || !embeddings || busy || (!searchEnabled && !embeddingsEnabled)}
          onchange={(event) => void toggleEmbeddings(event.currentTarget.checked)} />
      </td>
    </tr>
    <tr>
      <th scope="row">Observability Container App <small>Experimental</small></th>
      <td>Install local OpenObserve dashboards for HTTP, tools, runtime and embeddings telemetry. Sign-in is automatic.
        {#if observabilityEnabled && onOpenObservability}
          <button type="button" onclick={() => void onOpenObservability?.()}>Open Observability</button>
        {/if}
        {#if recoveryAppId}
          <button type="button" disabled={busy} onclick={() => void recoverObservability()}>Recover…</button>
        {/if}
      </td>
      <td>
        <input class="feature-switch" type="checkbox" role="switch" aria-label="Observability Container App"
          bind:checked={observabilityEnabled} disabled={!features || busy}
          onchange={(event) => void toggle('observability', event.currentTarget.checked)} />
      </td>
    </tr></tbody>
  </table>
  {#if busy}<p role="status">Applying feature settings. Container setup may take several minutes.</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if displayedError}
    <div class="feature-error" role="alert">
      <span class="feature-error-message">{displayedError}</span>
      <button class="report-bug-link" onclick={() => {
        reporting = $state.snapshot({
          error: displayedError, operation: error ? operation : pollError ? 'instance:features' : 'embeddings:dashboard',
          capturedAt: new Date().toISOString(), features, embeddingsEnabled,
          ...(error && requestedChange ? { requested: requestedChange } : {}),
        });
      }}>Bug Report</button>
    </div>
  {/if}
</section>

{#if reporting}
  <ReportBugDialog onClose={() => { reporting = null; }}
    evidenceDescription="Includes the selected error, feature settings, requested change, and the latest failed container setup's command timings and timeout limits. Review the report, then Send it through Feedback."
    capture={description => window.workingMemory.createFeatureBugReport({ description, failure: $state.snapshot(reporting!) })} />
{/if}

<style>
  section { display: grid; gap: 12px; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 12px; border-bottom: 1px solid var(--vscode-panel-border, #444); vertical-align: middle; }
  th:last-child, td:last-child { text-align: center; width: 80px; }
  small { display: block; font-weight: normal; color: var(--desktop-chat-muted); }
  .feature-error { display: flex; align-items: baseline; flex-wrap: wrap; gap: 8px 16px;
    padding: 10px 12px; color: #a12121; background: #ffeded; border: 1px solid #d88a8a; border-left: 4px solid #b3261e;
    border-radius: 4px; overflow-wrap: anywhere; }
  .report-bug-link { border: none; padding: 0; color: inherit; background: transparent; cursor: pointer;
    text-decoration: underline; font: inherit; white-space: nowrap; }
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
