<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import HostScripts from './HostScripts.svelte';
  import type { HostScriptDesktopState, ScriptTask } from '../shared/hostTasks';

  let { selectedId = '', revision = 0, active = true, onSelect, onAdd }: {
    selectedId?: string; revision?: number; active?: boolean;
    onSelect: (task: ScriptTask) => void; onAdd: () => Promise<void>;
  } = $props();
  let state = $state<HostScriptDesktopState | null>(null);
  let loading = $state(false);
  let error = $state('');
  let showRevoked = $state(false);
  let adding = $state(false);
  let request = 0;
  let mounted = true;
  const tasks = $derived(state?.snapshot?.tasks.filter(task => showRevoked || !task.revokedAt) ?? []);

  async function refresh(): Promise<void> {
    if (!mounted || !active || loading || document.hidden) return;
    const current = ++request;
    loading = true;
    error = '';
    try {
      const result = await window.workingMemory.getHostScripts();
      if (mounted && current === request) state = result;
    } catch (cause) {
      if (mounted && current === request) error = cause instanceof Error ? cause.message : String(cause);
    } finally { loading = false; }
  }
  $effect(() => { revision; active; untrack(() => { request++; void refresh(); }); });
  onMount(() => {
    const timer = setInterval(() => void refresh(), 2000);
    const visible = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', visible);
      document.removeEventListener('visibilitychange', visible);
    };
  });
  onDestroy(() => { mounted = false; request++; });
</script>

<section aria-label="Host tasks">
  <div class="list-actions">
    <button disabled={adding || loading || !state?.credentialReady || state.features?.hostTasks === false}
      onclick={async () => {
        adding = true;
        try { await onAdd(); }
        catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
        finally { adding = false; }
      }}>
      {adding ? 'Adding…' : 'Add script'}
    </button>
  </div>
  {#if error}<p class="container-panel-error" role="alert">{error}</p>{/if}
  {#if loading && !state}<p role="status">Loading host tasks…</p>{/if}
  {#if state && !state.credentialReady}
    <div class="connection">
      <HostScripts connectionOnly onConnectionChanged={(connected) => { if (connected) void refresh(); }} />
    </div>
  {:else if state?.snapshot}
    <label class="revoked-filter"><input type="checkbox" bind:checked={showRevoked} /> Show revoked tasks</label>
    <div class="container-app-list" role="list" aria-label="Registered host tasks">
      {#each tasks as task (task.id)}
        <div role="listitem">
          <button class="container-app-list-item" class:selected={selectedId === task.id}
            aria-pressed={selectedId === task.id} title={task.draftDescription ?? task.description} onclick={() => onSelect(task)}>
            <span class="codicon codicon-checklist" aria-hidden="true"></span>
            <span class="container-app-list-label">{task.draftName ?? task.name}</span>
            <small>{task.revokedAt ? 'Revoked' : task.hostId === state?.hostId ? 'This computer' : 'Other computer'}</small>
          </button>
        </div>
      {:else}
        <p class="container-app-list-empty">No tasks yet. Choose Add script to create one.</p>
      {/each}
    </div>
  {/if}
</section>

<style>
  .list-actions { display: flex; gap: 8px; padding: 10px; }
  .connection { padding: 12px; }
  .revoked-filter { display: flex; align-items: center; gap: 6px; padding: 4px 12px; font-size: 11px; }
  .revoked-filter input { width: auto; }
  small { color: var(--desktop-chat-muted); font-size: 10px; }
</style>
