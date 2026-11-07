<script lang="ts">
  import type { SearchWorkstream } from '../../../../shared/documentSearch';
  import type { TopicLinkReference } from '../resourceDrag';
  let { topic, title = 'Add to workstream', description, submitLabel = 'Add', onChoose, onClose }: {
    topic: TopicLinkReference;
    title?: string;
    description: string;
    submitLabel?: string;
    onChoose: (workstream: SearchWorkstream) => Promise<void>;
    onClose: () => void;
  } = $props();
  let dialog = $state<HTMLDialogElement>(null!);
  let workstreams = $state<SearchWorkstream[]>([]);
  let workstreamId = $state('');
  let loading = $state(true);
  let saving = $state(false);
  let error = $state('');
  let generation = 0;
  async function load(): Promise<void> {
    const current = ++generation;
    loading = true;
    error = '';
    try {
      const value = await window.workingMemory.listSearchWorkstreams();
      if (generation === current) workstreams = value;
    } catch (cause) {
      if (generation === current) error = cause instanceof Error ? cause.message : String(cause);
    } finally { if (generation === current) loading = false; }
  }
  $effect(() => {
    dialog.showModal();
    void load();
    return () => { generation++; };
  });
  async function choose(): Promise<void> {
    const workstream = workstreams.find(value => value.id === workstreamId);
    if (!workstream || saving) return;
    saving = true;
    error = '';
    try { await onChoose(workstream); onClose(); }
    catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { saving = false; }
  }
</script>

<dialog bind:this={dialog} aria-label={title} closedby={saving ? 'none' : 'closerequest'}
  oncancel={event => { event.preventDefault(); if (!saving) onClose(); }}>
  <h2>{title}</h2>
  <p>{topic.title}</p>
  <p>{description}</p>
  {#if loading}<p role="status">Loading open workstreams...</p>
  {:else if workstreams.length}
    <label>Open workstream
      <select bind:value={workstreamId} disabled={saving}>
        <option value="">Choose a workstream</option>
        {#each workstreams as ws (ws.id)}<option value={ws.id}>{ws.title}</option>{/each}
      </select>
    </label>
  {:else if !error}<p>No open workstreams are available.</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <footer>
    <button onclick={onClose} disabled={saving}>Cancel</button>
    {#if error && !workstreams.length}<button onclick={() => void load()}>Retry loading</button>{/if}
    <button class="primary" onclick={() => void choose()} disabled={saving || loading || !workstreamId}>
      {saving ? 'Working...' : submitLabel}
    </button>
  </footer>
</dialog>

<style>
  dialog { width: min(460px, 85vw); padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; }
  dialog::backdrop { background: #0006; }
  h2 { margin-top: 0; font-size: 16px; }
  label { display: grid; gap: 8px; }
  select { box-sizing: border-box; width: 100%; padding: 10px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 5px; font: inherit; }
  select:focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button { padding: 7px 12px; border: 1px solid var(--vscode-input-border); border-radius: 4px; background: transparent; color: inherit; }
  button:disabled { opacity: 0.6; cursor: default; }
  .primary { color: var(--desktop-accent-strong); border-color: var(--desktop-accent-strong); }
  .primary:hover:not(:disabled) { background: var(--desktop-accent-soft); }
  footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
  .error { color: var(--vscode-errorForeground); }
</style>
