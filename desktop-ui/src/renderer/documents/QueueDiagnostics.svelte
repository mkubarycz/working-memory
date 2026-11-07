<script lang="ts">
  import { onMount, untrack, type Snippet } from 'svelte';
  import { toolQueueSettingsSchema, type ToolQueueSettings, type DesktopToolQueue } from '../../../../control-plane/src/diagnosticContract';
  import { startVisiblePolling } from '../visiblePolling';
  import { toolQueueRequests, topQueueRequests } from '../toolQueueRequests';
  import { queueProcessingChart } from '../queueProcessingChart';
  import { queueDropsChart } from '../queueDropsChart';
  import { toolRequestsChart } from '../toolRequestsChart';
  import DiagnosticsTimeSeries from './DiagnosticsTimeSeries.svelte';

  let { refreshIntervalMs = 15000, refreshControl }: { refreshIntervalMs?: number; refreshControl?: Snippet } = $props();
  let mounted = $state(false);
  let result = $state<DesktopToolQueue | null>(null);
  let error = $state('');
  let busy = $state(false);
  let saving = $state(false);
  let dirty = $state(false);
  let settingsError = $state('');
  let settingsStatus = $state('');
  let draft = $state<ToolQueueSettings | null>(null);
  let timeoutSeconds = $state(5);
  let baseSettings: ToolQueueSettings | null = null;
  let baseBootId = '';
  let generation = 0;
  let bucketMs = $state(60000);
  let selectedTool = $state<string | null>(null);
  let waitOpen = $state(false);
  let runtimeOpen = $state(false);
  let logOpen = $state(false);
  let active = true;
  const date = (at: number) => new Date(at).toLocaleTimeString();
  const snapshot = $derived(result?.snapshot);
  const requests = $derived(snapshot ? toolQueueRequests(snapshot) : []);
  const topWait = $derived(topQueueRequests(requests, 'waitMs'));
  const topRuntime = $derived(topQueueRequests(requests, 'runMs'));
  const milliseconds = (value: number | null) => value === null ? '-' : value.toFixed(0);
  const chart = $derived(snapshot ? queueProcessingChart(snapshot, bucketMs) : null);
  const toolsChart = $derived(snapshot && chart ? toolRequestsChart(snapshot, chart, bucketMs, selectedTool) : null);
  const dropsChart = $derived(snapshot && chart ? queueDropsChart(snapshot, chart, bucketMs) : null);

  function apply(next: DesktopToolQueue): void {
    result = next;
    if (!dirty && next.snapshot?.settings) {
      draft = { ...next.snapshot.settings };
      timeoutSeconds = next.snapshot.settings.queueTimeoutMs / 1000;
      baseSettings = { ...next.snapshot.settings };
      baseBootId = next.snapshot.bootId;
    }
  }

  function editSettings(): void {
    dirty = true;
    generation++;
    settingsError = '';
    settingsStatus = '';
  }

  async function saveSettings(): Promise<void> {
    if (saving || !draft || !baseSettings || !result?.endpoint) return;
    const checked = toolQueueSettingsSchema.safeParse({ ...draft, queueTimeoutMs: timeoutSeconds * 1000 });
    if (!checked.success) {
      settingsError = 'Enter values within the displayed ranges.';
      return;
    }
    const endpoint = result.endpoint;
    saving = true;
    generation++;
    settingsError = '';
    settingsStatus = '';
    try {
      const next = await window.workingMemory.updateToolQueueSettings({
        expectedBootId: baseBootId, expectedSettings: baseSettings, settings: checked.data,
      }, endpoint);
      if (!active) return;
      dirty = false;
      apply({ endpoint, snapshot: next, error: null });
      settingsStatus = 'Queue settings saved.';
    } catch (cause) {
      if (active) settingsError = cause instanceof Error ? cause.message : String(cause);
    } finally { saving = false; }
  }

  function resetDraft(): void {
    dirty = false;
    settingsError = '';
    settingsStatus = '';
    if (result) apply(result);
  }

  async function refresh(): Promise<void> {
    if (busy || saving) return;
    const current = generation;
    busy = true;
    try {
      const next = await window.workingMemory.getToolQueue();
      if (!active || document.hidden || current !== generation) return;
      apply(next);
      error = '';
    } catch (cause) {
      if (active && !document.hidden && current === generation) { error = cause instanceof Error ? cause.message : String(cause); result = null; }
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

{#snippet requestTable(rows: typeof requests, label: string)}
  <table aria-label={label}>
    <thead><tr><th title="Queue-entry time">Time</th><th title="Queued to finished; elapsed so far for live requests">Duration ms</th><th>Request ID</th><th>Tool</th><th>Wait time ms</th><th>Runtime ms</th><th>Status</th></tr></thead>
    <tbody>{#each rows as request (request.requestId)}
      <tr><td>{date(request.queuedAt)}</td><td>{milliseconds(request.durationMs)}</td>
        <td title={`Caller: ${request.caller}`}>{request.requestId}</td><td>{request.operation}</td>
        <td>{milliseconds(request.waitMs)}</td><td>{milliseconds(request.runMs)}</td><td>{request.state}</td></tr>
    {:else}<tr><td colspan="7">No recent tool requests.</td></tr>{/each}</tbody>
  </table>
{/snippet}

<section aria-label="Tool queue">
  <h3>MCP tool queue</h3>
  <p>{result?.endpoint ?? 'Selected environment'}</p>
  {#if error || result?.error}<p role="alert">{error || result?.error}</p>{/if}
  {#if snapshot}
    <p>{snapshot.waiting} waiting / {snapshot.limits.waiting} &middot;
      {snapshot.running} running / {snapshot.limits.running} &middot;
      Maximum queue wait {snapshot.limits.waitMs / 1000} seconds</p>
    {#if snapshot.memoryBlocked}<p role="status">Dispatch paused at the {snapshot.settings?.heapDispatchPausePercent ?? 60}% heap threshold. Already-started calls may finish.</p>{/if}
  {/if}
  <div class="graph-header">
    <h4>Queue Processing</h4>
    <div class="chart-controls">
    {#if refreshControl}{@render refreshControl()}{/if}
    <label class="bucket-size">Bucket size
      <select aria-label="Queue bucket size" bind:value={bucketMs}>
        <option value={15000}>15 seconds</option>
        <option value={30000}>30 seconds</option>
        <option value={60000}>1 minute</option>
        <option value={120000}>2 minutes</option>
        <option value={300000}>5 minutes</option>
        <option value={600000}>10 minutes</option>
      </select>
    </label>
    </div>
  </div>
  {#if snapshot}
    {#if chart}
      <DiagnosticsTimeSeries {chart} label="Queue processing history"
        showExplanation={false} showPercentages={false}
        emptyMessage="No queue samples are available." syncGroup="queue-diagnostics" />
    {/if}
    {#if !snapshot.processing}<p role="status">Processing metrics unavailable on this backend.</p>{/if}
    <h4>Drops</h4>
    {#if dropsChart}
      <DiagnosticsTimeSeries chart={dropsChart} stacked label="Queue drops history"
        showExplanation={false} showPercentages={false} syncGroup="queue-diagnostics"
        emptyMessage="Collecting drop history. Older samples cannot be backfilled." />
    {/if}
    <h4>Tool requests over time</h4>
    {#if toolsChart}
      <DiagnosticsTimeSeries chart={toolsChart} stacked label="Tool request history" bind:selected={selectedTool}
        showExplanation={false} showPercentages={false}
        emptyMessage={snapshot.requestsByTool === undefined
          ? 'Tool-request history is unavailable on this backend. Upgrade it to collect per-tool counts; older samples cannot be backfilled.'
          : 'Collecting tool-request history. Two samples from the same backend run are needed.'}
        syncGroup="queue-diagnostics" />
      {#if !toolsChart.series.some(series => series.overlay && series.points.some(point => point.value !== null))}
        <p role="status">Collecting wait/runtime history. Older samples cannot be backfilled.</p>
      {/if}
    {/if}
    <section class="queue-settings" aria-label="Queue settings">
      <h4>Queue settings</h4>
      {#if draft && snapshot.settings}
        <form onsubmit={event => { event.preventDefault(); void saveSettings(); }}>
          <fieldset disabled={saving}>
            <label>Max Concurrency
              <input aria-label="Max Concurrency" type="number" min="1" max="64" step="1"
                bind:value={draft.maxConcurrency} oninput={editSettings} />
              <small>1-64</small>
            </label>
            <label>Max Queue Size
              <input aria-label="Max Queue Size" type="number" min="1" max="1000" step="1"
                bind:value={draft.maxQueueSize} oninput={editSettings} />
              <small>1-1000</small>
            </label>
            <label>Queue Timeout (seconds)
              <input aria-label="Queue Timeout" type="number" min="0.1" max="300" step="0.1"
                bind:value={timeoutSeconds} oninput={editSettings} />
              <small>0.1-300 seconds; new arrivals only</small>
            </label>
            <label>% Heap Dispatch Pause Threshold
              <input aria-label="Heap Dispatch Pause Threshold" type="number" min="10" max="90" step="1"
                bind:value={draft.heapDispatchPausePercent} oninput={editSettings} />
              <small>10-90%; new-session admission keeps its separate 60% cutoff</small>
            </label>
          </fieldset>
          <div class="settings-actions">
            <button type="submit" disabled={!dirty || saving}>Save Queue settings</button>
            <button type="button" disabled={saving || !dirty} onclick={resetDraft}>Discard changes</button>
          </div>
        </form>
      {:else}<p role="status">Queue settings are unavailable on this backend. Upgrade it to configure them.</p>{/if}
      {#if settingsError}<p role="alert">{settingsError}</p>{/if}
      {#if settingsStatus}<p role="status">{settingsStatus}</p>{/if}
    </section>
    <details bind:open={waitOpen}><summary>Top 50 by wait time</summary>
      {#if waitOpen}{@render requestTable(topWait, 'Top 50 by wait time')}{/if}
    </details>
    <details bind:open={runtimeOpen}><summary>Top 50 by runtime</summary>
      {#if runtimeOpen}{@render requestTable(topRuntime, 'Top 50 by runtime')}{/if}
    </details>
    <details bind:open={logOpen}><summary>Queue log</summary>
      {#if logOpen}{@render requestTable(requests, 'Queue request log')}{/if}
    </details>
  {/if}
</section>

<style>
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
  th, td { text-align: left; padding: 6px; border-bottom: 1px solid var(--border-color, #444); overflow-wrap: anywhere; }
  .graph-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
  .chart-controls { display: flex; align-items: center; gap: 16px; margin-left: auto; flex-wrap: wrap; }
  .chart-controls :global(.refresh-control) { margin-bottom: 0; }
  .bucket-size { display: flex; align-items: center; gap: 8px; }
  fieldset { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; border: 0; padding: 0; }
  .queue-settings label { display: flex; flex-direction: column; gap: 4px; }
  .queue-settings input { width: 100%; box-sizing: border-box; }
  small { color: var(--text-secondary); }
  .settings-actions { display: flex; gap: 8px; margin: 12px 0; }
  summary { cursor: pointer; padding: 10px 0; font-weight: 600; }
</style>
