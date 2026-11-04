<script lang="ts">
  import { onMount } from 'svelte';
  import type { DesktopDiagnostics } from '../../../../control-plane/src/diagnosticContract';

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
      if (active) { snapshot = result; error = ''; }
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
    } finally { busy = false; }
  }
  onMount(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => { active = false; clearInterval(timer); };
  });
</script>

<section class="diagnostics">
  <h2>Instance diagnostics</h2>
  <p>Only the selected environment is monitored while the desktop is running. Reports are queued locally during outages and
    saved as topics in Inbox when the instance is reachable and signed in. Review there before sending feedback.</p>
  <p>No credentials, document content, request bodies, query strings or raw logs are collected.</p>
  <button disabled={busy} onclick={() => void refresh()}>Refresh</button>
  {#if error || snapshot?.error}<p role="alert">{error || snapshot?.error}</p>{/if}
  {#if snapshot?.instance}
    {@const instance = snapshot.instance}
    <h3>Runtime</h3>
    <p>Backend {instance.version} &middot; Started {date(instance.startedAt)}</p>
    <p>Heap {mib(instance.runtime.heapUsedBytes)} / {mib(instance.runtime.heapLimitBytes)} &middot;
      RSS {mib(instance.runtime.rssBytes)} &middot; Event-loop max {instance.runtime.eventLoopMaxMs.toFixed(0)} ms</p>
    <p>{instance.runtime.activeSessions} active MCP sessions &middot; {instance.runtime.activeRequests} in-flight HTTP requests</p>
    {#if instance.runtime.admissionBlocked}<p role="alert">New MCP sessions blocked by the 60% heap safety cutoff.</p>{/if}
    <h3>HTTP transactions per minute</h3>
    <table>
      <thead><tr><th>Minute</th><th>Transactions</th><th>Errors</th><th>Average ms</th><th>Max ms</th></tr></thead>
      <tbody>{#each instance.minutes as minute (minute.at)}
        <tr><td>{date(minute.at)}</td><td>{minute.transactions}</td><td>{minute.errors}</td>
          <td>{minute.averageMs.toFixed(0)}</td><td>{minute.maxMs.toFixed(0)}</td></tr>
      {/each}</tbody>
    </table>
    <h3>Callers, routes and status codes (last minute)</h3>
    <table>
      <thead><tr><th>Caller</th><th>Route</th><th>HTTP status</th><th>Transactions</th></tr></thead>
      <tbody>{#each instance.callers as caller}
        <tr><td>{caller.caller}</td><td>{caller.route}</td><td>{caller.status}</td><td>{caller.transactions}</td></tr>
      {/each}</tbody>
    </table>
    <h3>Persistent instance error log</h3>
    <p>Newest 100 events; repeated errors are grouped by minute. Request ID identifies the latest occurrence in each group.</p>
    <table>
      <thead><tr><th>Time</th><th>Event</th><th>Route / HTTP</th><th>Duration ms</th><th>Count</th><th>Request ID</th></tr></thead>
      <tbody>{#each instance.events as event (event.sequence)}
        <tr><td>{date(event.at)}</td><td>{event.code}</td><td>{event.route} / {event.status}</td>
          <td>{event.durationMs.toFixed(0)}</td><td>{event.count}</td><td>{event.requestId ?? '-'}</td></tr>
      {/each}</tbody>
    </table>
  {/if}
  <h3>Automatic incident reports</h3>
  {#each snapshot?.incidents ?? [] as incident (incident.id)}
    <article>
      <strong>{incident.kind.replaceAll('_', ' ')} &middot; {date(incident.at)}</strong>
      <p>{incident.evidence}</p>
      {#if incident.topicId}
        <a href={`working-memory://open/topic/${incident.topicId}`}>Open report in Inbox</a>
      {:else}<p>Queued for Inbox. {incident.deliveryError ?? 'Waiting for the selected backend to recover.'}</p>{/if}
    </article>
  {:else}<p>No incidents recorded for this environment.</p>{/each}
</section>

<style>
  .diagnostics { overflow: auto; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
  th, td { text-align: left; padding: 6px; border-bottom: 1px solid var(--border-color, #444); overflow-wrap: anywhere; }
  article { padding: 12px 0; border-bottom: 1px solid var(--border-color, #444); }
</style>
