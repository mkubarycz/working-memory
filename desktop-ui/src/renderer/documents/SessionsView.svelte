<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { sessionPolicySchema, type SessionPolicy, type SessionSnapshot } from '../../../../control-plane/src/sessionPolicy';

  let { mcpUrl }: { mcpUrl: string | null } = $props();
  const instanceUrl = untrack(() => mcpUrl);
  let snapshot = $state<SessionSnapshot | null>(null);
  let draft = $state<SessionPolicy | null>(null);
  let events = $state<SessionSnapshot['events']>([]);
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
  };
  const date = (timestamp: number) => new Date(timestamp).toLocaleString();
  const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;

  function apply(result: SessionSnapshot): void {
    snapshot = result;
    if (!dirty) draft = { ...result.policy };
    if (!viewingHistory) { events = result.events; cursor = result.nextCursor; }
  }
  async function refresh(reset = false): Promise<void> {
    if (busy || refreshing) return;
    refreshing = true;
    const current = generation;
    try {
      const result = await window.workingMemory.getSessionDiagnostics();
      if (active && current === generation) {
        if (reset) viewingHistory = false;
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
        viewingHistory = true;
        apply(result);
        const seen = new Set(events.map(event => event.sequence));
        events = [...events, ...result.events.filter(event => !seen.has(event.sequence))];
        cursor = result.nextCursor;
      }
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
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false; generation += 1;
      clearInterval(timer); clearTimeout(saveTimer);
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
    <button disabled={busy || refreshing} onclick={() => void refresh(true)}>{refreshing ? 'Refreshing...' : 'Refresh'}</button>
  </header>
  <p class="muted">Live MCP connections for the selected instance. Owner sign-in is required. Application names are self-reported.</p>
  {#if validationError || error || pollError}<p role="alert">{validationError || error || pollError}</p>{/if}
  {#if snapshot && draft}
    <div class="session-memory" class:blocked={snapshot.memory.admissionBlocked}>
      <strong>JavaScript heap: {mib(snapshot.memory.heapUsedBytes)} / {mib(snapshot.memory.heapLimitBytes)}</strong>
      <progress aria-label="JavaScript heap usage" value={snapshot.memory.heapUsedBytes} max={snapshot.memory.heapLimitBytes}></progress>
      <span>New-session safety cutoff: {mib(snapshot.memory.admissionThresholdBytes)} (60%).
        {snapshot.memory.admissionBlocked ? 'New sessions are currently paused.' : 'New sessions can be admitted within the limits below.'}</span>
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
      {viewingHistory ? 'History is paused; Refresh returns to the latest events. Active sessions still update.' : 'Updates every 5 seconds.'}</p>
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
  progress { width: 100%; }
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
