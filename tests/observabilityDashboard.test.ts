import { expect, it } from 'vitest';
import { observabilityDashboard, observabilityLogsUrl } from '../shared/observabilityDashboard';

const origin = 'http://localhost:50865';
it('provides HTTP, queue and runtime tabs with separate real-unit graphs and explicit memory streams', () => {
  const dashboard = observabilityDashboard(origin);
  expect(dashboard.version).toBe(8);
  const panels = dashboard.tabs.flatMap(tab => tab.panels);
  expect(dashboard.tabs.map(tab => tab.name)).toEqual(['Processing queue', 'HTTP', 'Runtime', 'Embeddings']);
  expect(dashboard.tabs[0].tabId).toBe('queue');
  expect(panels).toHaveLength(31);
  const memory = panels.find(panel => panel.id === 'runtime-memory');
  expect(memory?.queries.map(query => ({ query: query.query, legend: query.config.promql_legend }))).toEqual([
    { query: 'avg_over_time(wm_process_heap_used_bytes[1m]) / 1048576', legend: 'Heap used' },
    { query: 'avg_over_time(wm_process_resident_memory_bytes[1m]) / 1048576', legend: 'RSS' },
    { query: 'avg_over_time(wm_process_external_memory_bytes[1m]) / 1048576', legend: 'External memory' },
  ]);
  const http = panels.find(panel => panel.id === 'http-transactions')!;
  expect(http.queries.map(query => query.config.promql_legend)).toEqual(['Transactions / min', 'Errors / min']);
  expect(panels.find(panel => panel.id === 'http-duration')!.queries[1].query).toContain('max_over_time');
  for (const tab of dashboard.tabs) for (const panel of tab.panels) {
    expect(panel.layout.w).toBe(panel.type === 'table' ? 192 : 96);
    expect(panel.queries.every(query => query.customQuery)).toBe(true);
    if (panel.queryType === 'promql') expect(panel.queries.every(query => query.fields.stream_type === 'metrics')).toBe(true);
  }
});

it('preserves every legacy runtime-history series with minute aggregation and real units', () => {
  const runtime = observabilityDashboard(origin).tabs.find(tab => tab.tabId === 'runtime')!;
  expect(runtime.panels).toHaveLength(7);
  const queries = (id: string) => runtime.panels.find(panel => panel.id === id)!.queries.map(query => query.query);
  expect(queries('runtime-cpu')).toEqual(['avg_over_time(wm_process_cpu_ratio[1m]) * 100']);
  expect(queries('runtime-event-loop')).toEqual(['max_over_time(wm_event_loop_delay_max_seconds[1m]) * 1000']);
  expect(queries('runtime-gc-count')).toEqual(['sum(increase(wm_gc_collections_total[1m]))']);
  expect(queries('runtime-gc-duration')).toEqual(['sum(increase(wm_gc_duration_seconds_total[1m])) * 1000']);
  expect(queries('runtime-tool-activity')).toEqual([
    'avg_over_time(wm_tool_queue_depth[1m])', 'avg_over_time(wm_tool_running[1m])',
  ]);
});

it('keeps processing failures, request arrivals and telemetry loss separate', () => {
  const panels = observabilityDashboard(origin).tabs.flatMap(tab => tab.panels);
  const graphLink = panels.find(panel => panel.id === 'http-transactions')!.config.drilldown![0];
  expect(graphLink.data).toMatchObject({
    url: expect.stringContaining('&from=${start_time}&to=${end_time}'),
  });
  expect(panels.find(panel => panel.id === 'queue-drops')!.queries[0].query).toContain('wm_tool_queue_drops_total');
  expect(panels.find(panel => panel.id === 'queue-requests')!.queries[0].query)
    .toBe('sum(increase(wm_tool_requests_total[1m])) by (tool)');
  expect(panels.find(panel => panel.id === 'queue-requests')).toMatchObject({
    type: 'stacked', queries: [{ config: { promql_legend: '{tool}' } }],
    config: { drilldown: [{ name: 'Queue logs', type: 'byUrl' }] },
  });
  expect(panels.find(panel => panel.id === 'queue-processed')!.queries[0].query).toContain('wm_tool_execution_seconds_count');
  expect(panels.find(panel => panel.id === 'telemetry-drops')!.queries[0].query).toBe('wm_telemetry_dropped_logs_total');
});

it('uses native single-brace label templates for every grouped metric legend', () => {
  const panels = observabilityDashboard(origin).tabs.flatMap(tab => tab.panels);
  const expected = {
    'queue-drops': '{reason}', 'queue-requests': '{tool}',
    'embeddings-operations': '{operation} / {outcome}', 'embeddings-duration': '{operation}',
    'embeddings-stages': '{operation} / {stage}', 'embeddings-phase': '{phase}',
  };
  for (const [id, legend] of Object.entries(expected)) {
    expect(panels.find(panel => panel.id === id)!.queries[0].config.promql_legend).toBe(legend);
  }
  for (const panel of panels) for (const query of panel.queries) {
    expect(query.config.promql_legend).not.toMatch(/\{\{|\}\}/);
  }
});

it('filters source links and restricts top-50 tables to terminal records with request-scoped drilldowns', () => {
  for (const source of ['http', 'queue', 'embeddings'] as const) {
    const url = new URL(observabilityLogsUrl(origin, source, { from: 1000000, to: 2000000 }));
    expect(url.origin).toBe(origin);
    expect(url.pathname).toBe('/web/logs');
    expect(url.searchParams.get('stream_type')).toBe('logs');
    expect(url.searchParams.get('from')).toBe('1000000');
    expect(Buffer.from(url.searchParams.get('query')!, 'base64').toString()).toContain(`WHERE source = '${source}'`);
  }
  const panels = observabilityDashboard(origin).tabs.flatMap(tab => tab.panels);
  const tables = panels.filter(panel => panel.type === 'table');
  expect(tables).toHaveLength(2);
  for (const panel of tables) {
    expect(panel.queries[0].query).toContain("source = 'queue' AND phase = 'finished'");
    expect(panel.queries[0].query).toMatch(/ORDER BY (wait_ms|run_ms) DESC, _timestamp DESC, request_id ASC LIMIT 50$/);
    const drilldown = panel.config.drilldown![0];
    expect(drilldown.targetBlank).toBe(true);
    expect(drilldown.data).toMatchObject({
      logsMode: 'custom',
      logsQuery: expect.stringContaining(`request_id = \${row.field["request_id"]} AND instance = \${row.field["instance"]}`),
    });

  }
});

it('provides embeddings history with operation outcomes, bounded state and source-filtered log links', () => {
  const tab = observabilityDashboard(origin).tabs.find(tab => tab.tabId === 'embeddings')!;
  expect(tab.panels).toHaveLength(11);
  const queries = tab.panels.flatMap(panel => panel.queries.map(query => query.query)).join('\n');
  for (const name of ['wm_embeddings_indexed_documents', 'wm_embeddings_pending_documents', 'wm_embeddings_limited_documents',
    'wm_embeddings_operations_total', 'wm_embeddings_operation_duration_seconds', 'wm_embeddings_stage_duration_seconds',
    'wm_embeddings_model_rss_bytes', 'wm_embeddings_vector_bytes', 'wm_embeddings_download_bytes',
    'wm_embeddings_phase', 'wm_embeddings_snapshot_available', 'wm_embeddings_last_indexed_timestamp_seconds']) {
    expect(queries).toContain(name);
  }
  for (const panel of tab.panels) expect(panel.config.drilldown![0]).toMatchObject({
    name: 'Embeddings logs', type: 'byUrl', targetBlank: true,
  });
});

it('provides saved header-help descriptions without standalone guide panels or GC abbreviations', () => {
    for (const tab of observabilityDashboard(origin).tabs) {
      expect(Math.min(...tab.panels.map(panel => panel.layout.y))).toBe(0);
      for (const panel of tab.panels) {
        expect(panel.id).not.toMatch(/-guide$/);
        expect(panel.type).not.toBe('html');
        expect(panel.description.length).toBeGreaterThan(30);
        expect(panel.title).not.toMatch(/\bGC\b/);
        expect(panel.queries.map(query => query.config.promql_legend).join(' ')).not.toMatch(/\bGC\b/);
      }
    }
});
