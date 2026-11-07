<script lang="ts">
  import { onMount } from 'svelte';
  import type { EChartsType } from 'echarts/core';
  import type { DiagnosticsChartData } from '../diagnosticsChart';

  let { chart, label, description = '', emptyMessage, stacked = false, syncGroup, showExplanation = true,
    showPercentages = true, selected = $bindable(null) }: {
    chart: DiagnosticsChartData;
    label: string;
    description?: string;
    emptyMessage: string;
    stacked?: boolean;
    syncGroup?: string;
    showExplanation?: boolean;
    showPercentages?: boolean;
    selected?: string | null;
  } = $props();
  let element: HTMLDivElement;
  let instance: EChartsType | undefined;
  let runtime: typeof import('../diagnosticsECharts') | undefined;
  let chartError = $state('');
  let active = false;
  let loading = false;
  let resize: ResizeObserver | undefined;
  function update(): void {
    const data = chart, selection = selected, bars = stacked, percentages = showPercentages;
    if (instance && runtime) instance.setOption(runtime.diagnosticsChartOption(data, selection, bars, percentages), { notMerge: true });
  }
  async function initialize(): Promise<void> {
    if (loading || instance) return;
    loading = true;
    chartError = '';
    try {
      runtime = await import('../diagnosticsECharts');
      if (!active) return;
      instance = runtime.init(element, undefined, {
        renderer: 'svg', width: element.parentElement?.clientWidth || 800, height: 260,
      });
      if (syncGroup) { instance.group = syncGroup; runtime.connect(syncGroup); }
      update();
      resize = new ResizeObserver(() => { if (element.clientWidth) instance?.resize({ width: element.clientWidth }); });
      resize.observe(element);
    } catch (cause) {
      instance?.dispose();
      instance = undefined;
      if (active) chartError = cause instanceof Error ? cause.message : String(cause);
    } finally { loading = false; }
  }
  onMount(() => {
    active = true;
    void initialize();
    return () => {
      active = false;
      resize?.disconnect();
      if (syncGroup) runtime?.disconnect(syncGroup);
      instance?.dispose();
      instance = undefined;
    };
  });
  $effect(() => {
    if (selected !== null && !chart.series.some(series => series.key === selected)) selected = null;
    update();
  });
</script>

<section class="diagnostics-time-series" aria-label={label}>
  {#if description}<p>{description}</p>{/if}
  {#if chartError}<p role="alert">Chart unavailable: {chartError}
    <button onclick={() => void initialize()}>Retry chart</button></p>{/if}
  {#if !stacked && showExplanation}
    <p>Each series has its own scale: 0-100% of its peak in this window, without smoothing.
      Compare patterns, not absolute magnitudes. Hover for original values.</p>
  {/if}
  <div bind:this={element} class="diagnostics-chart" role="img" aria-label={label}
    style:display={chart.hasData ? undefined : 'none'}></div>
  {#if chart.hasData}
    <ul class="chart-legend">
      {#each chart.series as series (series.key)}
        <li>
          {#if series.overlay}
            <span style:border-left={`3px solid ${series.color}`}>{series.label} · peak {series.peak.toLocaleString()} {series.unit}</span>
          {:else}<button style:border-left={`3px solid ${series.color}`} aria-pressed={selected === series.key}
            title="Show only this series; click again to show all"
            onclick={() => { selected = selected === series.key ? null : series.key; }}>
            <strong>{series.label}</strong> · peak {series.peak.toLocaleString()} {series.unit}
          </button>{/if}
        </li>
      {/each}
      <li><button disabled={selected === null} onclick={() => { selected = null; }}>Show all</button></li>
    </ul>
  {:else}<p role="status">{emptyMessage}</p>{/if}
</section>

<style>
  .diagnostics-chart { width: 100%; height: 260px; }
  .chart-legend { display: flex; flex-wrap: wrap; gap: 8px; padding: 0; list-style: none; }
  .chart-legend button { padding: 4px 8px; color: inherit; background: transparent; border: 1px solid var(--vscode-input-border); text-align: left; }
  .chart-legend span { display: inline-block; padding: 4px 8px; }
  .chart-legend button[aria-pressed="true"] { background: var(--desktop-accent-soft); outline: 1px solid var(--desktop-accent-strong); }
</style>
