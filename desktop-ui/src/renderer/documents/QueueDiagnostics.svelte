<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { DesktopToolQueue } from '../../../../control-plane/src/diagnosticContract';
  import { startVisiblePolling } from '../visiblePolling';
  import { toolQueueRequests } from '../toolQueueRequests';
  import { queueProcessingChart } from '../queueProcessingChart';
  import { toolRequestsChart } from '../toolRequestsChart';
  import DiagnosticsTimeSeries from './DiagnosticsTimeSeries.svelte';

  let { refreshIntervalMs = 15000 }: { refreshIntervalMs?: number } = $props();
  let mounted = $state(false);
  let result = $state<DesktopToolQueue | null>(null);
  let error = $state('');
  let busy = $state(false);
  let active = true;
  const date = (at: number) => new Date(at).toLocaleTimeString();
  const snapshot = $derived(result?.snapshot);
  const requests = $derived(snapshot ? toolQueueRequests(snapshot) : []);
  const milliseconds = (value: number | null) => value === null ? '-' : value.toFixed(0);
  const chart = $derived(snapshot ? queueProcessingChart(snapshot) : null);
  const toolsChart = $derived(snapshot && chart ? toolRequestsChart(snapshot, chart) : null);
  const average = (value: number | null) => value === null ? '-' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;

  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const next = await window.workingMemory.getToolQueue();
      if (!active || document.hidden) return;
      result = next;
      error = '';
    } catch (cause) {
      if (active && !document.hidden) { error = cause instanceof Error ? cause.message : String(cause); result = null; }
    } finally { busy = false; }
  }
  onMount(() => {
    mounted = true;
    return () => { active = false; };
  });
  $effect(() => {
    if (!mounted) return;
    const interval = refreshIntervalMs;
    return untrack(() => startVisiblePolling(refresh, interval));
  });
</script>

<section aria-label="Tool queue">
  <h3>MCP tool queue</h3>
  <p>{result?.endpoint ?? 'Selected environment'}</p>
  {#if error || result?.error}<p role="alert">{error || result?.error}</p>{/if}
  {#if snapshot}
    <p>{snapshot.waiting} waiting / {snapshot.limits.waiting} &middot;
      {snapshot.running} running / {snapshot.limits.running} &middot;
      Maximum queue wait {snapshot.limits.waitMs / 1000} seconds</p>
    {#if snapshot.memoryBlocked}<p role="status">Dispatch paused at the 60% heap safety cutoff. Already-started calls may finish.</p>{/if}
    <h4>Queue Processing</h4>
    {#if chart}
      <DiagnosticsTimeSeries {chart} label="Queue processing history"
        description="One-minute buckets: average queue depth and sampled processing rate, with maximum peak waiting. The current minute is partial."
        emptyMessage="No queue samples are available." syncGroup="queue-diagnostics" />
    {/if}
    {#if snapshot.processing}
      <p class="processing-averages">
        <span>Average wait (1 min): <strong>{average(snapshot.processing.averageWaitMs)}</strong></span>
        <span>Average processing (1 min): <strong>{average(snapshot.processing.averageRunMs)}</strong></span>
      </p>
    {:else}<p role="status">Processing metrics unavailable on this backend.</p>{/if}
    <h4>Tool requests over time</h4>
    {#if toolsChart}
      <DiagnosticsTimeSeries chart={toolsChart} stacked label="Tool request history"
        description="One-minute totals of sampled tool requests, including rejected work. Sample intervals are assigned to their ending minute; hover shows counts and observed interval boundaries. Same time axis as Queue Processing; missing history is not zero activity."
        emptyMessage={snapshot.requestsByTool === undefined
          ? 'Tool-request history is unavailable on this backend. Upgrade it to collect per-tool counts; older samples cannot be backfilled.'
          : 'Collecting tool-request history. Two samples from the same backend run are needed.'}
        syncGroup="queue-diagnostics" />
    {/if}
    <h4>Queue log</h4>
    <table aria-label="Queue request log">
      <thead><tr><th title="Queue-entry time">Time</th><th title="Queued to finished; elapsed so far for live requests">Duration ms</th><th>Request ID</th><th>Tool</th><th>Wait time ms</th><th>Runtime ms</th><th>Status</th></tr></thead>
      <tbody>{#each requests as request (request.requestId)}
        <tr><td>{date(request.queuedAt)}</td><td>{milliseconds(request.durationMs)}</td>
          <td title={`Caller: ${request.caller}`}>{request.requestId}</td><td>{request.operation}</td>
          <td>{milliseconds(request.waitMs)}</td><td>{milliseconds(request.runMs)}</td><td>{request.state}</td></tr>
      {:else}<tr><td colspan="7">No recent tool requests.</td></tr>{/each}</tbody>
    </table>
  {/if}
</section>

<style>
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
  th, td { text-align: left; padding: 6px; border-bottom: 1px solid var(--border-color, #444); overflow-wrap: anywhere; }
  .processing-averages { display: flex; flex-wrap: wrap; gap: 18px; }
</style>
