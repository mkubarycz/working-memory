<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { DesktopDiagnostics } from '../../../../control-plane/src/diagnosticContract';
  import QueueDiagnostics from './QueueDiagnostics.svelte';
  import { startVisiblePolling } from '../visiblePolling';
  import EmbeddingsDashboard from './EmbeddingsDashboard.svelte';
  import type { ObservabilityStatus } from '../../../../control-plane/src/observability';
  import type { ObservabilityLogSource } from '../../../../shared/observabilityDashboard';

  let { onOpenObservability = () => window.workingMemory.openObservability(), onOpenFeatures }: {
    onOpenObservability?: () => Promise<void>; onOpenFeatures?: () => void;
  } = $props();
  const tabs = [
    { id: 'queue', label: 'Queue' }, { id: 'incidents', label: 'Automatic incident reports' },
    { id: 'embeddings', label: 'Embeddings' },
  ] as const;
  let tab = $state<'queue' | 'incidents' | 'embeddings'>('queue');
  let mounted = $state(false);
  let refreshIntervalMs = $state(15000);
  let snapshot = $state<DesktopDiagnostics | null>(null);
  let error = $state('');
  let busy = $state(false);
  let active = true;
  let observability = $state<ObservabilityStatus | null>(null);
  let observabilityError = $state('');
  async function refreshObservability(): Promise<void> {
    try {
      const features = await window.workingMemory.getInstanceFeatures();
      const status = features.observability ? await window.workingMemory.getObservability() : null;
      if (active) { observability = status; observabilityError = ''; }
    } catch (cause) {
      if (active) observabilityError = cause instanceof Error ? cause.message : String(cause);
    }
  }
  async function openObservability(source?: ObservabilityLogSource): Promise<void> {
    try {
      if (source) await window.workingMemory.openObservability(source);
      else await onOpenObservability();
      observabilityError = '';
    }
    catch (cause) { observabilityError = cause instanceof Error ? cause.message : String(cause); }
  }
  const date = (at: number) => new Date(at).toLocaleString();
  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const result = await window.workingMemory.getInstanceDiagnostics();
      if (active && !document.hidden && tab === 'incidents') { snapshot = result; error = ''; }
    } catch (cause) {
      if (active && !document.hidden && tab === 'incidents') error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; }
  }
  onMount(() => {
    mounted = true;
    const stop = startVisiblePolling(refreshObservability, 10000);
    return () => { active = false; stop(); };
  });
  $effect(() => {
    if (!mounted || tab !== 'incidents') return;
    const interval = refreshIntervalMs;
    return untrack(() => startVisiblePolling(refresh, interval));
  });
  function navigateTabs(event: KeyboardEvent): void {
    const index = tabs.findIndex(item => item.id === tab);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    tab = tabs[next].id;
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`#diagnostics-tab-${tab}`)?.focus();
    }
  }
</script>

{#snippet refreshControl()}
  <label class="refresh-control">Refresh
    <select aria-label="Refresh interval" bind:value={refreshIntervalMs}>
      <option value={2000}>2 seconds</option>
      <option value={5000}>5 seconds</option>
      <option value={15000}>15 seconds</option>
      <option value={30000}>30 seconds</option>
      <option value={60000}>1 minute</option>
    </select>
  </label>
{/snippet}

<section class="diagnostics">
  <div class="settings-tabs settings-subtabs diagnostics-tabs" role="tablist" aria-label="Diagnostics sections">
    {#each tabs as item (item.id)}
      <button id={`diagnostics-tab-${item.id}`} role="tab" aria-selected={tab === item.id}
        aria-controls={`diagnostics-panel-${item.id}`} tabindex={tab === item.id ? 0 : -1}
        onkeydown={navigateTabs} onclick={() => { tab = item.id; }}>{item.label}</button>
    {/each}
  </div>
  <div id={`diagnostics-panel-${tab}`} role="tabpanel" aria-labelledby={`diagnostics-tab-${tab}`}>
  <h2>Instance diagnostics</h2>
  {#if observabilityError}<p role="alert">{observabilityError}</p>{/if}
  {#if observability?.enabled}
    <h3>OpenObserve</h3>
    <p>HTTP, queue, runtime and embeddings history is available in OpenObserve with seven-day retention. Sign-in is automatic.</p>
    <button onclick={() => void openObservability()}>Open Observability</button>
    {#if tab === 'queue'}
      <button onclick={() => void openObservability('queue')}>Queue logs</button>
    {:else if tab === 'embeddings'}
      <button onclick={() => void openObservability('embeddings')}>Embeddings logs</button>
    {/if}
    <p>Last export: {observability.lastSuccessAt ? date(observability.lastSuccessAt) : 'Waiting for first export'}.
      Dropped logs: {observability.droppedLogs}. Dropped metric observations: {observability.droppedSeries}.</p>
    {#if observability.lastError}<p role="alert">{observability.lastError}</p>{/if}
  {:else}
    <p>Enable Observability in Settings &gt; Features for metric history and searchable logs.</p>
    {#if onOpenFeatures}<button onclick={onOpenFeatures}>Open Settings &gt; Features</button>{/if}
  {/if}
  {#if tab === 'embeddings'}
    <EmbeddingsDashboard />
  {:else if tab === 'queue'}
    <QueueDiagnostics {refreshIntervalMs} />
  {:else}
  {@render refreshControl()}
  {#if error || snapshot?.error}<p role="alert">{error || snapshot?.error}</p>{/if}
  <h3>Automatic incident reports</h3>
  <p>Only the selected environment is monitored while the desktop is running. Reports are queued locally during outages and
    saved as topics in Inbox when the instance is reachable and signed in. Review there before sending feedback.</p>
  {#each snapshot?.incidents ?? [] as incident (incident.id)}
    <article>
      <strong>{incident.kind.replaceAll('_', ' ')} &middot; {date(incident.at)}</strong>
      <p>{incident.evidence}</p>
      {#if incident.topicId}
        <a href={`working-memory://open/topic/${incident.topicId}`}>Open report in Inbox</a>
      {:else}<p>Queued for Inbox. {incident.deliveryError ?? 'Waiting for the selected backend to recover.'}</p>{/if}
    </article>
  {:else}<p>No incidents recorded for this environment.</p>{/each}
  {/if}
  </div>
</section>

<style>
  .diagnostics { overflow: auto; }
  article { padding: 12px 0; border-bottom: 1px solid var(--border-color, #444); }
  .diagnostics-tabs button { color: var(--desktop-accent-strong, #ad1b63); }
  .refresh-control { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
</style>
