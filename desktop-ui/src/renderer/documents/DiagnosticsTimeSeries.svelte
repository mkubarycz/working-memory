<script lang="ts">
  import { DIAGNOSTICS_CHART_BOUNDS as bounds, type normalizedDiagnosticsChart } from '../diagnosticsChart';

  let { chart, label, description, emptyMessage }: {
    chart: ReturnType<typeof normalizedDiagnosticsChart>;
    label: string;
    description: string;
    emptyMessage: string;
  } = $props();
</script>

<p>Each series is scaled independently to 0-100% of its peak in this window. Compare patterns, not absolute magnitudes.
  The legend shows raw peaks; hover a point for its original value.</p>
{#if chart.hasData}
  <svg viewBox="0 0 800 230" role="img" aria-label={label} class="diagnostics-chart">
    <title>{description}</title>
    {#each [0, 25, 50, 75, 100] as percent}
      {@const y = bounds.bottom - percent / 100 * (bounds.bottom - bounds.top)}
      <path d={`M${bounds.left},${y}H${bounds.right}`} class="chart-grid" />
      <text x="40" {y} text-anchor="end" dominant-baseline="middle">{percent}%</text>
    {/each}
    {#each chart.series as series (series.key)}
      <g data-series={series.key}>
        <path d={series.path} fill="none" stroke={series.color} stroke-width="2" stroke-dasharray={series.dash} />
        {#each series.points as point (point.at)}
          <circle cx={point.x} cy={point.y} r="3" fill={series.color}>
            <title>{`${new Date(point.at).toLocaleString()}: ${series.label} ${point.value.toLocaleString()} ${series.unit} (${point.normalized.toFixed(1)}% of peak)`}</title>
          </circle>
        {/each}
      </g>
    {/each}
    <text x={bounds.left} y="210">{new Date(chart.start).toLocaleTimeString()}</text>
    <text x={bounds.right} y="210" text-anchor="end">{new Date(chart.end).toLocaleTimeString()}</text>
  </svg>
  <ul class="chart-legend">
    {#each chart.series as series (series.key)}
      <li style={`border-left: 3px solid ${series.color}`}><strong>{series.label}</strong>
        &middot; peak {series.peak.toLocaleString()} {series.unit}</li>
    {/each}
  </ul>
{:else}<p>{emptyMessage}</p>{/if}

<style>
  .diagnostics-chart { display: block; width: 100%; max-height: 300px; color: var(--text-secondary, #aaa); font-size: 12px; }
  .diagnostics-chart text { fill: currentColor; }
  .chart-grid { fill: none; stroke: currentColor; opacity: 0.2; }
  .chart-legend { display: flex; flex-wrap: wrap; gap: 12px; padding: 0; list-style: none; }
  .chart-legend li { padding-left: 8px; }
</style>
