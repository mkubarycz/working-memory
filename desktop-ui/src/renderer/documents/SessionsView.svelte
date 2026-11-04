<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { sessionPolicySchema, type SessionPolicy, type SessionSnapshot } from '../../../../control-plane/src/sessionPolicy';
  import { heapCategories, heapPressure } from '../heapPresentation';

  let { mcpUrl }: { mcpUrl: string | null } = $props();
  const instanceUrl = untrack(() => mcpUrl);
  let snapshot = $state<SessionSnapshot | null>(null);
  let draft = $state<SessionPolicy | null>(null);
  let events = $state<SessionSnapshot['events']>([]);
  let historicalEvents: SessionSnapshot['events'] = [];
  let cursor = $state<number | null>(null);
  let viewingHistory = $state(false);
  let dirty = $state(false);
  let busy = $state(false);
  let refreshing = $state(false);
  let error = $state('');
  let validationError = $state('');
  let pollError = $state('');
  let status = $state('');
  let active = false;
  let generation = 0;
  let revision = 0;
  let pendingSave = false;
  let recoveryTopicId = $state<string | null>(null);
  let lastRefreshedAt = $state<number | null>(null);
  let now = $state(Date.now());
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const fields = [
    { key: 'idleMinutes', label: 'Idle timeout (minutes)', min: 1, max: 1440 },
    { key: 'maxPerClient', label: 'Active sessions per client', min: 1, max: 10000 },
    { key: 'maxTotal', label: 'Active sessions in total', min: 1, max: 10000 },
    { key: 'handshakesPerMinute', label: 'New-session attempts per client / minute', min: 1, max: 100000 },
    { key: 'retentionDays', label: 'Event retention (days)', min: 1, max: 365 },
  ] as const;
  const eventLabels: Record<SessionSnapshot['events'][number]['type'], string> = {
    opened: 'Session opened', closed: 'Session closed', idle_expired: 'Idle cleanup',
    client_quota: 'Client quota reached', global_quota: 'Global quota reached',
    rate_limited: 'Rate limit reached', memory_rejected: 'Memory safety cutoff',
    initialization_failed: 'Initialization failed', cleanup_failed: 'Cleanup failed',
    policy_updated: 'Policy updated', server_shutdown: 'Server shutdown',
    garbage_collected: 'Garbage collected', heap_collection_failed: 'Heap collection failed',
  };
  const date = (timestamp: number) => new Date(timestamp).toLocaleString();
  const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;

  function applyRuntime(result: SessionSnapshot): void {
    snapshot = result;
    if (!dirty) draft = { ...result.policy };
    now = Date.now();
    lastRefreshedAt = now;
  }
  function apply(result: SessionSnapshot): void {
    applyRuntime(result);
    if (viewingHistory) {
      const latest = new Set(result.events.map(event => event.sequence));
      events = [...result.events, ...historicalEvents.filter(event => !latest.has(event.sequence))]
        .sort((a, b) => b.sequence - a.sequence);
    } else {
      events = result.events; cursor = result.nextCursor; historicalEvents = [];
    }
  }
  async function refresh(): Promise<void> {
    if (busy || refreshing) return;
    refreshing = true;
    const current = generation;
    try {
      const result = await window.workingMemory.getSessionDiagnostics();
      if (active && current === generation) {
        apply(result);
        pollError = '';
      }
    } catch (cause) {
      if (active && current === generation) pollError = cause instanceof Error ? cause.message : String(cause);
    } finally { refreshing = false; }
  }
  function scheduleSave(): void {
    dirty = true;
    revision += 1;
    generation += 1;
    error = '';
    clearTimeout(saveTimer);
    saveTimer = undefined;
    pendingSave = sessionPolicySchema.safeParse($state.snapshot(draft)).success;
    validationError = pendingSave ? ''
      : 'Enter whole numbers within the displayed ranges. The per-client limit must not exceed the total limit.';
    status = pendingSave ? 'Waiting to save...' : 'Changes not saved.';
    if (pendingSave) saveTimer = setTimeout(() => { saveTimer = undefined; void save(); }, 400);
  }
  function commit(): void {
    if (dirty && !busy && !validationError) {
      pendingSave = true;
      void save();
    }
  }
  async function persist(policy: SessionPolicy): Promise<SessionSnapshot> {
    if (!instanceUrl) throw new Error('Select a Working Memory instance first.');
    return window.workingMemory.updateSessionPolicy(policy, instanceUrl);
  }
  async function save(): Promise<void> {
    if (!active || busy || !pendingSave) return;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    pendingSave = false;
    const checked = sessionPolicySchema.safeParse($state.snapshot(draft));
    if (!checked.success) {
      validationError = 'Enter whole numbers within the displayed ranges. The per-client limit must not exceed the total limit.';
      status = 'Changes not saved.';
      return;
    }
    const savingRevision = revision;
    busy = true;
    generation += 1;
    error = ''; status = 'Saving...';
    try {
      const result = await persist(checked.data);
      if (active) {
        if (savingRevision === revision) {
          dirty = false;
          status = 'Saved automatically.';
        }
        viewingHistory = false; pollError = '';
        apply(result);
      }
    } catch (cause) {
      if (active) {
        error = cause instanceof Error ? cause.message : String(cause);
        if (savingRevision === revision) status = 'Not saved. Edit the value or leave the field to retry.';
      }
    } finally {
      busy = false;
      if (active && pendingSave && saveTimer === undefined) void save();
    }
  }
  async function older(): Promise<void> {
    if (cursor === null || busy || refreshing) return;
    busy = true; error = '';
    generation += 1;
    try {
      const result = await window.workingMemory.getSessionDiagnostics(cursor);
      if (active) {
        if (!viewingHistory) historicalEvents = events;
        viewingHistory = true;
        applyRuntime(result);
        const seen = new Set(events.map(event => event.sequence));
        events = [...events, ...result.events.filter(event => !seen.has(event.sequence))];
        const historical = new Set(historicalEvents.map(event => event.sequence));
        historicalEvents = [...historicalEvents, ...result.events.filter(event => !historical.has(event.sequence))];
        cursor = result.nextCursor;
      }
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      if (active && pendingSave && saveTimer === undefined) void save();
    }
  }
  async function recover(): Promise<void> {
    if (!instanceUrl || busy || refreshing) return;
    busy = true; error = ''; status = ''; generation += 1;
    try {
      const result = await window.workingMemory.recoverInstanceHeap(instanceUrl);
      if (!active) return;
      if (result.status === 'cancelled') { status = 'Cancelled. No report or garbage collection was requested.'; return; }
      recoveryTopicId = result.topicId;
      if (result.status === 'failed') { error = `Bug report saved; heap collection request failed: ${result.error}`; return; }
      viewingHistory = false;
      apply(result.snapshot);
      status = `Collected ${mib(result.collection.reclaimedBytes)} in ${result.collection.durationMs.toFixed(0)} ms; `
        + `${result.collection.idleSessionsReclaimed} idle sessions reclaimed. Live objects and active requests are preserved.`;
    } catch (cause) {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      busy = false;
      if (active && pendingSave && saveTimer === undefined) void save();
    }
  }
  onMount(() => {
    active = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    const clock = setInterval(() => { now = Date.now(); }, 1000);
    return () => {
      active = false; generation += 1;
      clearInterval(timer); clearInterval(clock); clearTimeout(saveTimer);
      if (pendingSave) {
        pendingSave = false;
        const checked = sessionPolicySchema.safeParse($state.snapshot(draft));
        if (checked.success) {
          void persist(checked.data).catch(cause => console.warn('[sessions] Pending limit changes were not saved:', cause));
        } else console.warn('[sessions] Pending limit changes are invalid:', checked.error);
      }
    };
  });
</script>

<section class="session-settings" aria-label="Instance sessions">
  <header>
    <h2>Sessions</h2>
    <span class="muted refresh-age" title={lastRefreshedAt === null ? undefined : date(lastRefreshedAt)}>
      {#if refreshing}Refreshing...
      {:else if lastRefreshedAt !== null}Last refreshed {Math.max(0, Math.floor((now - lastRefreshedAt) / 1000))}s ago
      {:else}Not refreshed yet{/if}
    </span>
  </header>
  <p class="muted">Live MCP connections for the selected instance. Owner sign-in is required. Application names are self-reported.</p>
  {#if validationError || error || pollError}<p role="alert">{validationError || error || pollError}</p>{/if}
  {#if snapshot && draft}
    {@const pressure = heapPressure(snapshot.memory)}
    {@const categories = heapCategories(snapshot.memory)}
    <div class="session-memory" class:blocked={pressure.severity === 'critical'} class:warning={pressure.severity === 'warning'}>
      <strong>JavaScript heap: {mib(snapshot.memory.heapUsedBytes)} / {mib(snapshot.memory.heapLimitBytes)}</strong>
      <span>{pressure.percent.toFixed(1)}% · {pressure.label}</span>
      <progress aria-label="JavaScript heap usage" value={snapshot.memory.heapUsedBytes} max={snapshot.memory.heapLimitBytes}></progress>
      <span>New-session safety cutoff: {mib(snapshot.memory.admissionThresholdBytes)} (60%).
        {snapshot.memory.admissionBlocked ? 'New sessions are currently paused.' : 'New sessions can be admitted within the limits below.'}</span>
      {#if categories.length}
        <strong>V8 allocation categories</strong>
        <div class="heap-breakdown" role="img" aria-label="V8 heap allocation categories">
          {#each categories as category}
            <span style:width={`${category.percent}%`} style:background={category.color}
              title={`${category.label}: ${mib(category.bytes)}`}></span>
          {/each}
        </div>
        <ul class="heap-legend">
          {#each categories as category}
            <li><span class="heap-swatch" style:background={category.color}></span>{category.label}: {mib(category.bytes)}</li>
          {/each}
        </ul>
        <small>Categories describe V8 storage, not which client owns objects. Live-object ownership requires an allocation profile;
          no raw heap snapshots are collected or sent automatically.</small>
      {:else}<small>Upgrade the backend to 1.4.1 for allocation-category details and manual collection.</small>{/if}
      {#if snapshot.memory.rssBytes !== undefined}
        <span>Process RSS: {mib(snapshot.memory.rssBytes)} · External: {mib(snapshot.memory.externalBytes ?? 0)} ·
          Array buffers: {mib(snapshot.memory.arrayBufferBytes ?? 0)} (included in external, outside JavaScript heap).</span>
      {/if}
      {#if pressure.severity === 'critical'}
        <p role="alert">We detected high heap usage. Save a bug report and request garbage collection.
          Collection cannot release live objects and is not a replacement for fixing retained sessions or allocations.</p>
      {/if}
      <button disabled={busy || refreshing || !snapshot.memory.gcAvailable} onclick={() => void recover()}>
        Save bug report and collect garbage
      </button>
      {#if !snapshot.memory.gcAvailable}<small>Manual collection requires a backend started with --expose-gc. No collection will be attempted.</small>{/if}
      {#if recoveryTopicId}<a href={`working-memory://open/topic/${recoveryTopicId}`}>Open saved heap bug report</a>{/if}
    </div>
    <form onsubmit={event => { event.preventDefault(); commit(); }} oninput={scheduleSave}>
      <h3>Protection limits</h3>
      <p class="muted">Count limits are ceilings, not reservations. Idle cleanup never interrupts an in-flight request or changes a client's permissions.
        Lower count limits affect new sessions; existing sessions remain until closed or idle.
        Valid changes save automatically.</p>
      <div class="session-limits">
        {#each fields as field}
          <label>{field.label}
            <input type="number" required step="1" min={field.min} max={field.max} bind:value={draft[field.key]} onblur={commit} />
            <small>{field.min} - {field.max}</small>
          </label>
        {/each}
      </div>
      <p role="status">{status}</p>
    </form>
    <h3>Active sessions ({snapshot.active.length} / {snapshot.policy.maxTotal})</h3>
    <p class="muted">Server started {date(snapshot.startedAt)}. Session IDs below are diagnostic IDs, not protocol credentials.</p>
    <div class="session-table">
      <table aria-label="Active MCP sessions">
        <thead><tr><th>Client / application</th><th>Opened</th><th>Last activity</th><th>In flight</th><th>Requests</th></tr></thead>
        <tbody>
          {#each snapshot.active as session (session.id)}
            <tr>
              <td><strong>{session.clientLabel}</strong><small>{session.application} · {session.state}</small><small>{session.id}</small></td>
              <td>{date(session.createdAt)}</td><td>{date(session.lastActivityAt)}</td>
              <td>{session.activeRequests}</td><td>{session.requests}</td>
            </tr>
          {:else}<tr><td colspan="5">No active MCP sessions.</td></tr>{/each}
        </tbody>
      </table>
    </div>
    <h3>Session events</h3>
    <p class="muted">Retained for {snapshot.policy.retentionDays} days across server restarts. Repeated rejections from a client are counted together per minute.
      Updates every 15 seconds while this tab is open. {#if viewingHistory}Loaded older events remain visible.{/if}</p>
    <div class="session-table">
      <table aria-label="Session event log">
        <thead><tr><th>Time</th><th>Event</th><th>Client / application</th><th>Count</th><th>Details</th></tr></thead>
        <tbody>
          {#each events as event (event.sequence)}
            <tr>
              <td>{date(event.lastAt)}{#if event.count > 1}<small>Since {date(event.firstAt)}</small>{/if}</td>
              <td>{eventLabels[event.type]}</td><td>{event.clientLabel}<small>{event.application}</small></td>
              <td>{event.count}</td><td>{event.detail}{#if event.sessionId}<small>{event.sessionId}</small>{/if}</td>
            </tr>
          {:else}<tr><td colspan="5">No session events in this retention window.</td></tr>{/each}
        </tbody>
      </table>
    </div>
    {#if cursor !== null}<button disabled={busy || refreshing} onclick={() => void older()}>Load older events</button>{/if}
  {:else if !pollError}<p>Loading sessions...</p>{/if}
</section>

<style>
  header { display: flex; align-items: center; gap: 12px; }
  header { justify-content: space-between; }
  h2 { margin: 0; }
  h3 { margin-top: 24px; }
  .muted, small { color: var(--desktop-chat-muted); }
  .session-memory { display: grid; gap: 8px; padding: 14px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; }
  .session-memory.blocked { border-color: var(--vscode-errorForeground); }
  .session-memory.warning { border-color: var(--vscode-editorWarning-foreground, #d09a42); }
  progress { width: 100%; accent-color: #36a875; }
  .warning progress { accent-color: #d09a42; }
  .blocked progress { accent-color: var(--vscode-errorForeground, #d45050); }
  .heap-breakdown { display: flex; height: 20px; border-radius: 4px; overflow: hidden; }
  .heap-breakdown span { display: block; }
  .heap-legend { display: flex; flex-wrap: wrap; gap: 8px 16px; list-style: none; padding: 0; margin: 0; font-size: 12px; }
  .heap-swatch { display: inline-block; width: 10px; height: 10px; margin-right: 6px; }
  .session-limits { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 12px; margin-bottom: 16px; }
  label { display: grid; align-content: start; gap: 6px; }
  input { width: 100%; box-sizing: border-box; }
  .session-table { width: 100%; overflow-x: auto; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  td, th { padding: 10px 8px; border-bottom: 1px solid var(--vscode-panel-border); vertical-align: top; }
  td { overflow-wrap: anywhere; min-width: 90px; }
  small { display: block; font-size: 11px; margin-top: 4px; }
  [role="alert"] { color: var(--vscode-errorForeground); }
</style>
