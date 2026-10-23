<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import HostScripts from './HostScripts.svelte';
  import type { HostScriptDesktopState, ScriptTask } from '../shared/hostTasks';

  let { selectedId = '', revision = 0, onSelect, onAdd }: {
    selectedId?: string; revision?: number;
    onSelect: (task: ScriptTask) => void; onAdd: () => void;
  } = $props();
  let state = $state<HostScriptDesktopState | null>(null);
  let loading = $state(false);
  let error = $state('');
  let showRevoked = $state(false);
  let request = 0;
  const tasks = $derived(state?.snapshot?.tasks.filter(task => showRevoked || !task.revokedAt) ?? []);

  async function refresh(): Promise<void> {
    const current = ++request;
    loading = true;
    error = '';
    try {
      const result = await window.workingMemory.getHostScripts();
      if (current === request) state = result;
    } catch (cause) {
      if (current === request) error = cause instanceof Error ? cause.message : String(cause);
    } finally { if (current === request) loading = false; }
  }
  $effect(() => { revision; untrack(() => { void refresh(); }); });
  onDestroy(() => { request++; });
</script>

<section aria-label="Host tasks">
  <div class="list-actions">
    <button disabled={loading || !state?.credentialReady} onclick={onAdd}>Add script</button>
    <button disabled={loading} onclick={() => void refresh()}>Refresh</button>
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
            aria-pressed={selectedId === task.id} title={task.description} onclick={() => onSelect(task)}>
            <span class="codicon codicon-checklist" aria-hidden="true"></span>
            <span class="container-app-list-label">{task.name}</span>
            <small>{task.revokedAt ? 'Revoked' : task.hostId === state?.hostId ? 'This computer' : 'Other computer'}</small>
          </button>
        </div>
      {:else}
        <p class="container-app-list-empty">No tasks added. Choose Add script to register one. No demo tasks are installed automatically.</p>
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
