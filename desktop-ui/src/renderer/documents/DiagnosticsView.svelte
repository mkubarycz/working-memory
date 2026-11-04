<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { DesktopDiagnostics } from '../../../../control-plane/src/diagnosticContract';
  import QueueDiagnostics from './QueueDiagnostics.svelte';
  import { httpDiagnosticsChart } from '../httpDiagnosticsChart';
  import { runtimeDiagnosticsChart } from '../runtimeDiagnosticsChart';
  import DiagnosticsTimeSeries from './DiagnosticsTimeSeries.svelte';
  import { startVisiblePolling } from '../visiblePolling';

  const tabs = [
    { id: 'queue', label: 'Queue' }, { id: 'http', label: 'HTTP' },
    { id: 'runtime', label: 'Runtime' }, { id: 'incidents', label: 'Automatic incident reports' },
  ] as const;
  let tab = $state<'queue' | 'http' | 'runtime' | 'incidents'>('queue');
  let mounted = $state(false);
  let refreshIntervalMs = $state(15000);
  let snapshot = $state<DesktopDiagnostics | null>(null);
  let error = $state('');
  let busy = $state(false);
  let active = true;
  const date = (at: number) => new Date(at).toLocaleString();
  const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;
  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const result = await window.workingMemory.getInstanceDiagnostics();
      if (active && !document.hidden && tab !== 'queue') { snapshot = result; error = ''; }
    } catch (cause) {
      if (active && !document.hidden && tab !== 'queue') error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; }
  }
  onMount(() => {
    mounted = true;
    return () => { active = false; };
  });
  $effect(() => {
    if (!mounted || tab === 'queue') return;
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
  <label class="refresh-control">Refresh
    <select aria-label="Refresh interval" bind:value={refreshIntervalMs}>
      <option value={2000}>2 seconds</option>
      <option value={5000}>5 seconds</option>
      <option value={15000}>15 seconds</option>
      <option value={30000}>30 seconds</option>
      <option value={60000}>1 minute</option>
    </select>
  </label>
  {#if tab === 'queue'}
    <QueueDiagnostics {refreshIntervalMs} />
  {:else}
  <p>Persisted telemetry excludes credentials, document content, request bodies, query strings and raw logs.</p>
  {#if error || snapshot?.error}<p role="alert">{error || snapshot?.error}</p>{/if}
  {#if snapshot?.instance && tab === 'runtime'}
    {@const instance = snapshot.instance}
    <h3>Runtime</h3>
    <p>Backend {instance.version} &middot; Started {date(instance.startedAt)}</p>
    <p>Heap {mib(instance.runtime.heapUsedBytes)} / {mib(instance.runtime.heapLimitBytes)} &middot;
      RSS {mib(instance.runtime.rssBytes)} &middot; Event-loop max {instance.runtime.eventLoopMaxMs.toFixed(0)} ms</p>
    <p>{instance.runtime.activeSessions} active MCP sessions &middot; {instance.runtime.activeRequests} in-flight HTTP requests</p>
    {#if instance.runtime.admissionBlocked}<p role="alert">New MCP sessions and queued tool dispatch blocked by the 60% heap safety cutoff.</p>{/if}
    <h3>Runtime history</h3>
    <p>CPU 100% is one logical core. GC is observed, never forced. Gaps and backend restarts break the traces.</p>
    <DiagnosticsTimeSeries chart={runtimeDiagnosticsChart(instance.samples)} label="Normalized runtime time series"
      description="Memory, CPU, event-loop delay, garbage collection and tool activity, independently normalized to each series' peak"
      emptyMessage="No runtime samples are available for this environment." />
  {:else if snapshot?.instance && tab === 'http'}
    {@const instance = snapshot.instance}
    <h3>HTTP time series</h3>
    <p>Observed {date(instance.observedAt)}. Minute buckets may be incomplete; durations include long-poll and stream waiting.</p>
    <DiagnosticsTimeSeries chart={httpDiagnosticsChart(instance.minutes)} label="Normalized HTTP time series"
      description="Transactions, errors, average and maximum duration, independently normalized to each series' peak"
      emptyMessage="No HTTP samples are available for this environment." />
    <h3>Persistent instance error log</h3>
    <p>Newest 100 events; repeated errors are grouped by minute. Request ID identifies the latest occurrence in each group.</p>
    <table>
      <thead><tr><th>Time</th><th>Event</th><th>Route / HTTP</th><th>Duration ms</th><th>Count</th><th>Request ID</th></tr></thead>
      <tbody>{#each instance.events as event (event.sequence)}
        <tr><td>{date(event.at)}</td><td>{event.code}</td><td>{event.route} / {event.status}</td>
          <td>{event.durationMs.toFixed(0)}</td><td>{event.count}</td><td>{event.requestId ?? '-'}</td></tr>
      {/each}</tbody>
    </table>
    <details>
      <summary>Current callers, routes and status codes (last minute)</summary>
      <p>This is a current breakdown, not a time series.</p>
      <ul>{#each instance.callers as caller}
        <li>{caller.caller} &middot; {caller.route} &middot; HTTP {caller.status} &middot; {caller.transactions} transactions</li>
      {:else}<li>No caller activity in the last minute.</li>{/each}</ul>
    </details>
  {/if}
  {#if tab === 'incidents'}
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
  {/if}
  </div>
</section>

<style>
  .diagnostics { overflow: auto; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
  th, td { text-align: left; padding: 6px; border-bottom: 1px solid var(--border-color, #444); overflow-wrap: anywhere; }
  article { padding: 12px 0; border-bottom: 1px solid var(--border-color, #444); }
  .diagnostics-tabs button { color: var(--desktop-accent-strong, #ad1b63); }
  .refresh-control { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
</style>
