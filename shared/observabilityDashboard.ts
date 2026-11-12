export type ObservabilityLogSource = 'http' | 'queue' | 'embeddings';

export function observabilityLogsUrl(origin: string, source: ObservabilityLogSource,
  range?: { from: number; to: number }): string {
  const url = new URL('/web/logs', origin);
  url.search = new URLSearchParams({
    org_identifier: 'default', stream_type: 'logs', stream: 'wm_diagnostics', sql_mode: 'true',
    query: Buffer.from(`SELECT * FROM "wm_diagnostics" WHERE source = '${source}' ORDER BY _timestamp DESC`).toString('base64'),
    show_histogram: 'true',
    ...(range ? { from: String(range.from), to: String(range.to) } : {}),
  }).toString();
  return url.toString();
}

const field = (column: string, label = column) => ({
  column, alias: column, label, aggregationFunction: null, color: null, isDerived: false,
});
const fields = (stream_type: 'metrics' | 'logs', x: ReturnType<typeof field>[] = [],
  y: ReturnType<typeof field>[] = []) => ({
  stream: stream_type === 'logs' ? 'wm_diagnostics' : '', stream_type, x, y, z: [],
  filter: { filterType: 'group', logicalOperator: 'AND', conditions: [] },
});
const metric = (query: string, legend: string, unit: string) => ({
  query, customQuery: true, config: { promql_legend: legend }, fields: fields('metrics', [], [field('value', unit)]),
});

export function observabilityDashboard(origin: string) {
  const logs = (source: ObservabilityLogSource) => [{
    name: `${{ http: 'HTTP', queue: 'Queue', embeddings: 'Embeddings' }[source]} logs`, type: 'byUrl', targetBlank: true,
    data: { url: `${observabilityLogsUrl(origin, source)}&from=\${start_time}&to=\${end_time}` },
  }];
  const line = (id: string, title: string, queries: ReturnType<typeof metric>[],
    description: string, source?: ObservabilityLogSource) => ({
    id, type: 'line', title, description, queryType: 'promql',
    config: { show_legends: true, legends_position: 'bottom', ...(source ? { drilldown: logs(source) } : {}) },
    queries,
  });
  const table = (id: string, title: string, sort: 'wait_ms' | 'run_ms') => ({
    id, type: 'table', title, queryType: 'sql',
    description: 'Finished requests in the selected time range. Click a row, then Request logs, for its queue lifecycle.',
    config: { show_legends: false, table_pagination: false, drilldown: [{
      name: 'Request logs', type: 'logs', targetBlank: true,
      data: { logsMode: 'custom',
        logsQuery: `SELECT * FROM "wm_diagnostics" WHERE source = 'queue' AND request_id = \${row.field["request_id"]} AND instance = \${row.field["instance"]} ORDER BY _timestamp ASC` },
    }] },
    queries: [{
      query: `SELECT _timestamp, instance, request_id, tool, event, wait_ms, run_ms FROM "wm_diagnostics" WHERE source = 'queue' AND phase = 'finished'${sort === 'run_ms' ? " AND event IN ('completed', 'failed')" : ''} ORDER BY ${sort} DESC, _timestamp DESC, request_id ASC LIMIT 50`,
      customQuery: true, config: { promql_legend: '' },
      fields: fields('logs', ['_timestamp', 'instance', 'request_id', 'tool', 'event', 'wait_ms', 'run_ms'].map(column => field(column))),
    }],
  });
  type Chart = ReturnType<typeof line> | ReturnType<typeof table>;
  const tab = (tabId: string, name: string, panels: Chart[]) => {
    let x = 0, y = 0;
    return { tabId, name, panels: panels.map((panel, index) => {
      const wide = panel.type === 'table';
      if (wide && x) { x = 0; y += 12; }
      const layout = { x, y, w: wide ? 192 : 96, h: wide ? 24 : 12, i: index + 1 };
      if (wide) y += 24;
      else if (x) { x = 0; y += 12; }
      else x = 96;
      return { ...panel, layout };
    }) };
  };
  return {
    version: 8, title: 'Working Memory diagnostics',
    description: 'Managed baseline v6. Processing queue opens first. Metric information is available in chart headers in Working Memory. Adjacent charts retain real units. Rates use one-minute windows; counts reset on backend restart. HTTP includes long polls and closed streams. Logs are bounded, best-effort diagnostic records, not an audit trail.',
    tabs: [
      tab('queue', 'Processing queue', [
        line('queue-depth', 'Maximum queue depth', [
          metric('max(max_over_time(wm_tool_queue_peak_depth[1m]))', 'Max queue depth', 'waiting'),
        ], 'Peak waiting requests in the last minute. The admission queue records each depth change, including bursts between exports.', 'queue'),
        line('queue-timing', 'Queue wait and runtime (ms)', [
          metric('max(max_over_time(wm_tool_queue_max_wait_seconds[1m])) * 1000', 'Maximum wait', 'ms'),
          metric('sum(rate(wm_tool_queue_wait_seconds_sum[1m])) / sum(rate(wm_tool_queue_wait_seconds_count[1m])) * 1000', 'Average wait', 'ms'),
          metric('sum(rate(wm_tool_execution_seconds_sum[1m])) / sum(rate(wm_tool_execution_seconds_count[1m])) * 1000', 'Average runtime', 'ms'),
        ], 'Admission queue timestamps measure waiting and execution. One-minute averages/maximum; wait includes drops, runtime only executed calls.', 'queue'),
        line('queue-processed', 'Average processed / second', [
          metric('sum(rate(wm_tool_execution_seconds_count[1m]))', 'Processed / sec', 'requests/sec'),
        ], 'Completed and failed tool executions per second from queue completion counters, averaged over one minute. Excludes unexecuted calls.', 'queue'),
        line('queue-drops', 'Queue drops (/min)', [
          metric('sum(rate(wm_tool_queue_drops_total[1m])) by (reason) * 60', '{reason}', 'drops/min'),
        ], 'One-minute rates from admission-queue rejection counters: timeout, full queue and shutdown. Not telemetry-export loss.', 'queue'),
        { ...line('queue-requests', 'Total requests over time (requests/min by tool)', [
          metric('sum(increase(wm_tool_requests_total[1m])) by (tool)', '{tool}', 'requests/min'),
        ], 'Per-tool arrival counters, increased over one minute. Each admitted or rejected call is counted once, not once per lifecycle log.', 'queue'), type: 'stacked' },
        line('queue-total-wait', 'Total queue wait (ms/min)', [
          metric('sum(increase(wm_tool_queue_wait_seconds_sum[1m])) * 1000', 'Total wait', 'ms/min'),
        ], 'Sum of admission-queue waiting durations for finished/dropped calls in the last minute, measured from queue timestamps.', 'queue'),
        line('queue-logs', 'Queue lifecycle logs / second', [
          metric('sum(rate(wm_diagnostic_logs_exported_total{source="queue"}[1m]))', 'Queue logs / sec', 'logs/sec'),
        ], 'Successfully exported queued, started and finished records. Click for queue-filtered log search.', 'queue'),
        table('queue-top-wait', 'Top 50 requests by wait time', 'wait_ms'),
        table('queue-top-runtime', 'Top 50 requests by runtime', 'run_ms'),
      ]),
      tab('default', 'HTTP', [
        line('http-transactions', 'HTTP transactions and errors (/min)', [
          metric('sum(rate(wm_http_requests_total[1m])) * 60', 'Transactions / min', 'requests/min'),
          metric('sum(rate(wm_http_errors_total[1m])) * 60', 'Errors / min', 'requests/min'),
        ], 'Completed requests per minute, counted by the backend HTTP response/stream completion hooks; errors are HTTP 400+.', 'http'),
        line('http-duration', 'HTTP average and maximum duration (ms)', [
          metric('sum(rate(wm_http_duration_seconds_total[1m])) / sum(rate(wm_http_requests_total[1m])) * 1000', 'Average duration', 'ms'),
          metric('max(max_over_time(wm_http_max_duration_seconds[1m])) * 1000', 'Maximum duration', 'ms'),
        ], 'Elapsed time from HTTP arrival to response/stream completion. One-minute average and maximum; includes long-poll waiting.', 'http'),
        line('http-logs', 'HTTP diagnostic logs / second', [
          metric('sum(rate(wm_diagnostic_logs_exported_total{source="http"}[1m]))', 'HTTP logs / sec', 'logs/sec'),
        ], 'Successfully exported error/slow-request records, not an access log of every successful HTTP request. Click for HTTP logs.', 'http'),
        line('http-long-poll', 'Long-poll requests / second', [
          metric('sum(rate(wm_http_request_duration_seconds_count{request_class="long_poll"}[1m]))', 'Long polls / sec', 'requests/sec'),
        ], 'Completed change-poll requests per second, classified by the backend HTTP recorder and averaged over one minute.', 'http'),
      ]),
      tab('runtime', 'Runtime', [
        line('runtime-memory', 'Memory history (MiB)', [
          metric('avg_over_time(wm_process_heap_used_bytes[1m]) / 1048576', 'Heap used', 'MiB'),
          metric('avg_over_time(wm_process_resident_memory_bytes[1m]) / 1048576', 'RSS', 'MiB'),
          metric('avg_over_time(wm_process_external_memory_bytes[1m]) / 1048576', 'External memory', 'MiB'),
        ], 'Node process.memoryUsage samples, averaged over one minute: JavaScript heap, resident process memory and native memory associated with JavaScript objects.'),
        line('runtime-cpu', 'CPU history (%)', [
          metric('avg_over_time(wm_process_cpu_ratio[1m]) * 100', 'CPU', '%'),
        ], 'Node process.cpuUsage deltas divided by elapsed time, averaged over one minute. 100% is one logical core.'),
        line('runtime-event-loop', 'Event-loop delay (ms)', [
          metric('max_over_time(wm_event_loop_delay_max_seconds[1m]) * 1000', 'Event-loop maximum', 'ms'),
        ], 'Node monitorEventLoopDelay samples at 20 ms resolution; maximum observed delay in the last minute.'),
        line('runtime-gc-count', 'Garbage Collection count (/min)', [
          metric('sum(increase(wm_gc_collections_total[1m]))', 'Garbage Collection count', 'collections/min'),
        ], 'Collections observed by Node PerformanceObserver, summed per minute using cumulative counters. Collection is never forced.'),
        line('runtime-gc-duration', 'Garbage Collection duration (ms/min)', [
          metric('sum(increase(wm_gc_duration_seconds_total[1m])) * 1000', 'Garbage Collection duration', 'ms/min'),
        ], 'Collection durations observed by Node PerformanceObserver, summed per minute. Repeated exports do not double-count observations.'),
        line('runtime-tool-activity', 'Tool activity history (tools)', [
          metric('avg_over_time(wm_tool_queue_depth[1m])', 'Waiting tools', 'tools'),
          metric('avg_over_time(wm_tool_running[1m])', 'Running tools', 'tools'),
        ], 'Admission-queue waiting and running counts sampled by backend runtime telemetry, averaged over one minute.'),
        line('telemetry-drops', 'Dropped telemetry records / observations', [
          metric('wm_telemetry_dropped_logs_total', 'Dropped logs', 'records'),
          metric('wm_telemetry_dropped_series_total', 'Dropped metric observations', 'records'),
        ], 'Exporter loss is separate from processing-queue drops. These cumulative counters reset on restart.'),
      ]),
      tab('embeddings', 'Embeddings', [
        line('embeddings-coverage', 'Document coverage and backlog', [
          metric('wm_embeddings_documents', 'Total documents', 'documents'),
          metric('wm_embeddings_indexed_documents', 'Indexed', 'documents'),
          metric('wm_embeddings_pending_documents', 'Pending', 'documents'),
          metric('wm_embeddings_limited_documents', 'Limited coverage', 'documents'),
        ], 'Existing SQLite embedding-stat aggregates sampled every ten seconds. Pending means new/changed documents; limited means body coverage was capped.', 'embeddings'),
        line('embeddings-operations', 'Indexing and search operations (/min)', [
          metric('sum(rate(wm_embeddings_operations_total{outcome=~"completed|failed"}[1m])) by (operation, outcome) * 60',
            '{operation} / {outcome}', 'operations/min'),
        ], 'Indexer/search completion counters per minute. Indexed means accepted vector writes; cancellations and superseded writes are not failures.', 'embeddings'),
        line('embeddings-duration', 'Average completed operation duration (ms)', [
          metric('sum(rate(wm_embeddings_operation_duration_seconds_sum{outcome="completed"}[1m])) by (operation) / sum(rate(wm_embeddings_operation_duration_seconds_count{outcome="completed"}[1m])) by (operation) * 1000',
            '{operation}', 'ms'),
        ], 'Indexer/search wall-clock durations, averaged over one minute. Includes host communication and busy retries, not the outer admission queue.', 'embeddings'),
        line('embeddings-stages', 'Average inference and stage duration (ms)', [
          metric('sum(rate(wm_embeddings_stage_duration_seconds_sum[1m])) by (operation, stage) / sum(rate(wm_embeddings_stage_duration_seconds_count[1m])) by (operation, stage) * 1000',
            '{operation} / {stage}', 'ms'),
        ], 'Successful inference, host round trip, cold startup (when reported), search ranking and vector submission. Stages overlap; do not sum them.', 'embeddings'),
        line('embeddings-memory', 'Host model RSS (MiB)', [
          metric('wm_embeddings_model_rss_bytes / 1048576', 'Host inference RSS', 'MiB'),
        ], 'Host /status resident memory, polled every ten seconds. Shared across environments: do not sum copies. Missing readings are omitted.', 'embeddings'),
        line('embeddings-vectors', 'Stored passage vectors (MiB)', [
          metric('wm_embeddings_vector_bytes / 1048576', 'Stored vectors', 'MiB'),
        ], 'Stored vector-byte totals from existing SQLite embedding stats, sampled every ten seconds; excludes database overhead and exports no vectors.', 'embeddings'),
        line('embeddings-download', 'Model download (MiB)', [
          metric('wm_embeddings_download_bytes / 1048576', 'Transferred during download', 'MiB'),
          metric('wm_embeddings_download_total_bytes / 1048576', 'Expected model size', 'MiB'),
        ], 'Host /status download progress and configured model size, sampled every ten seconds. Zero outside downloading does not mean the cached model is missing.', 'embeddings'),
        line('embeddings-phase', 'Embedding phase (active = 1)', [
          metric('wm_embeddings_phase', '{phase}', 'state'),
        ], 'Indexer settings and host /status sampled every ten seconds: disabled, paused, downloading, starting, indexing, idle or error.', 'embeddings'),
        line('embeddings-health', 'Embedding availability and errors (0/1)', [
          metric('wm_embeddings_enabled', 'Enabled', 'state'),
          metric('wm_embeddings_snapshot_available', 'Snapshot available', 'state'),
          metric('wm_embeddings_model_memory_available', 'Model RSS available', 'state'),
          metric('wm_embeddings_error', 'Error reported', 'state'),
        ], 'Ten-second indexer/host snapshots report enabled, snapshot/memory availability and errors. An unloaded model is normal before inference or after idle unloading.', 'embeddings'),
        line('embeddings-freshness', 'Time since last indexing success (seconds)', [
          metric('time() - wm_embeddings_last_indexed_timestamp_seconds', 'Last indexed age', 'seconds'),
        ], 'Current time minus the latest successful SQLite vector-write timestamp, sampled every ten seconds. Absent before first success; age can grow normally while idle.', 'embeddings'),
        line('embeddings-logs', 'Embedding diagnostic logs / second', [
          metric('sum(rate(wm_diagnostic_logs_exported_total{source="embeddings"}[1m]))', 'Embedding logs / sec', 'logs/sec'),
        ], 'Index/search outcomes, phase transitions and sampling failures only. Raw shared host logs, queries, passages, vectors, endpoints and credentials are not exported.', 'embeddings'),
      ]),
    ],
  };
}
