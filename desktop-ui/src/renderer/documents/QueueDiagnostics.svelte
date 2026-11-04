<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { DesktopToolQueue } from '../../../../control-plane/src/diagnosticContract';
  import { startVisiblePolling } from '../visiblePolling';
  import { toolQueueRequests } from '../toolQueueRequests';
  import { queueProcessingChart } from '../queueProcessingChart';

  let { refreshIntervalMs = 15000 }: { refreshIntervalMs?: number } = $props();
  let mounted = $state(false);
  let result = $state<DesktopToolQueue | null>(null);
  let error = $state('');
  let busy = $state(false);
  let inspecting = $state(false);
  let selected = $state<string | null>(null);
  let payload = $state<unknown>(undefined);
  let detailError = $state('');
  let active = true;
  const date = (at: number) => new Date(at).toLocaleTimeString();
  const age = (at: number, now: number) => `${(Math.max(0, now - at) / 1000).toFixed(1)} s`;
  const snapshot = $derived(result?.snapshot);
  const requests = $derived(snapshot ? toolQueueRequests(snapshot) : []);
  const milliseconds = (value: number | null) => value === null ? '-' : value.toFixed(0);
  const chart = $derived(snapshot ? queueProcessingChart(snapshot) : null);
  const average = (value: number | null) => value === null ? '-' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} ms`;

  function clearDetail(): void { selected = null; payload = undefined; detailError = ''; }
  async function refresh(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const next = await window.workingMemory.getToolQueue();
      if (!active || document.hidden) return;
      if (next.endpoint !== result?.endpoint || next.snapshot?.bootId !== result?.snapshot?.bootId
        || selected && !next.snapshot?.items.some(item => item.requestId === selected && item.startedAt === undefined)) clearDetail();
      result = next;
      error = '';
    } catch (cause) {
      if (active && !document.hidden) { error = cause instanceof Error ? cause.message : String(cause); result = null; clearDetail(); }
    } finally { busy = false; }
  }
  async function inspect(requestId: string): Promise<void> {
    const endpoint = result?.endpoint;
    if (!endpoint) return;
    selected = requestId; payload = undefined; detailError = ''; inspecting = true;
    try {
      const detail = await window.workingMemory.inspectQueuedRequest(requestId, endpoint);
      if (active && selected === requestId && result?.endpoint === endpoint
        && result.snapshot?.items.some(item => item.requestId === requestId && item.startedAt === undefined)) payload = detail.body;
    } catch (cause) {
      if (active && selected === requestId) detailError = cause instanceof Error ? cause.message : String(cause);
    } finally { if (selected === requestId) inspecting = false; }
  }
  onMount(() => {
    mounted = true;
    return () => { active = false; clearDetail(); };
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
    <svg viewBox="0 0 800 180" role="img" aria-label="Queue processing history" class="depth-chart">
      <title>Queue depth and items processed per second</title>
      <path d="M40 20V140H740" fill="none" stroke="currentColor" />
      <text x="4" y="25">{snapshot.limits.waiting}</text>
      <text x="20" y="143">0</text>
      <text x="40" y="12">Waiting</text>
      <text x="792" y="12" text-anchor="end">Items / sec</text>
      <text x="750" y="25">{chart.maxRate.toLocaleString()}</text>
      <text x="750" y="143">0</text>
      <polyline points={chart.depthLine} fill="none" stroke="var(--accent-color, #6ea8fe)" stroke-width="2" />
      <polyline points={chart.peakLine} fill="none" stroke="#d99b42" stroke-width="2" stroke-dasharray="4 3" />
      <g data-series="processedPerSecond">
        <path d={chart.processingPath} fill="none" stroke="#67c9a5" stroke-width="2" />
        {#each chart.processingPoints as point (point.at)}
          <circle cx={point.x} cy={point.y} r="3" fill="#67c9a5">
            <title>{`${date(point.at)}: ${point.value.toLocaleString()} items / sec`}</title>
          </circle>
        {/each}
      </g>
      <text x="40" y="168">{date(chart.points[0].at)}</text>
      <text x="740" y="168" text-anchor="end">{date(snapshot.observedAt)}</text>
    </svg>
    <ul class="chart-legend">
      <li style="border-color: var(--accent-color, #6ea8fe)">Queue depth</li>
      <li style="border-color: #d99b42">Peak depth</li>
      <li style="border-color: #67c9a5">Processed / sec (right axis)</li>
    </ul>
    {/if}
    {#if snapshot.processing}
      <p class="processing-averages">
        <span>Average wait (1 min): <strong>{average(snapshot.processing.averageWaitMs)}</strong></span>
        <span>Average processing (1 min): <strong>{average(snapshot.processing.averageRunMs)}</strong></span>
      </p>
    {:else}<p role="status">Processing metrics unavailable on this backend.</p>{/if}
    <h4>Live requests</h4>
    <p>Select a waiting request to inspect its JSON. Request bodies are not recorded.</p>
    <table>
      <thead><tr><th>Request ID</th><th>Tool</th><th>State</th><th>Age</th><th>Caller</th></tr></thead>
      <tbody>{#each snapshot.items as item (item.requestId)}
        <tr><td>{#if item.startedAt === undefined}
          <button class="request-link" onclick={() => void inspect(item.requestId)}>{item.requestId}</button>
        {:else}{item.requestId}{/if}</td><td>{item.operation}</td>
          <td>{item.startedAt === undefined ? 'Waiting' : 'Running'}</td>
          <td>{age(item.startedAt ?? item.queuedAt, snapshot.observedAt)}</td><td>{item.caller}</td></tr>
      {:else}<tr><td colspan="5">No tool calls waiting or running.</td></tr>{/each}</tbody>
    </table>
    {#if selected}
      <section aria-label="Queued request inspector">
        <h4>Queued request {selected}</h4>
        <button onclick={clearDetail}>Close request</button>
        {#if detailError}<p role="alert">{detailError}</p>
        {:else if inspecting}<p>Loading request...</p>
        {:else if payload !== undefined}<pre>{JSON.stringify(payload, null, 2)}</pre>{/if}
      </section>
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
  .depth-chart { display: block; width: 100%; max-height: 220px; color: var(--text-secondary, #aaa); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
  th, td { text-align: left; padding: 6px; border-bottom: 1px solid var(--border-color, #444); overflow-wrap: anywhere; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 400px; overflow: auto; padding: 12px; background: var(--surface-secondary, #222); }
  .request-link { color: var(--accent-color, #6ea8fe); background: none; border: 0; padding: 0; text-align: left; cursor: pointer; }
  .chart-legend { display: flex; flex-wrap: wrap; gap: 16px; padding: 0; list-style: none; }
  .chart-legend li { border-left: 3px solid; padding-left: 8px; }
  .processing-averages { display: flex; flex-wrap: wrap; gap: 24px; }
</style>
