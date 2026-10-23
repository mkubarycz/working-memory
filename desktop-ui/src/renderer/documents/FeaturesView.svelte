<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { InstanceFeatures } from '../../../../control-plane/src/instanceFeatures';

  let { onChanged }: { onChanged: (features: InstanceFeatures) => void } = $props();
  let features = $state<InstanceFeatures | null>(null);
  let enabled = $state(false);
  let busy = $state(false);
  let error = $state('');
  let active = true;

  async function load(): Promise<void> {
    try {
      const loaded = await window.workingMemory.getInstanceFeatures();
      if (!active) return;
      features = loaded;
      enabled = features.hostTasks;
      error = '';
      onChanged(features);
    } catch (cause) { if (active) error = cause instanceof Error ? cause.message : String(cause); }
  }
  async function toggle(requested: boolean): Promise<void> {
    busy = true;
    error = '';
    try {
      const saved = await window.workingMemory.setInstanceFeatures({ hostTasks: requested });
      if (!active) return;
      features = saved;
      onChanged(features);
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
    finally { enabled = features?.hostTasks ?? false; busy = false; }
  }
  onMount(() => { void load(); });
  onDestroy(() => { active = false; });
</script>

<section aria-label="Feature flags">
  <h2>Features</h2>
  <p>Features apply to the selected instance and all its clients.</p>
  <table>
    <thead><tr><th>Feature name</th><th>Short description</th><th>Enabled</th></tr></thead>
    <tbody><tr>
      <th scope="row">Host tasks <small>Experimental</small></th>
      <td>Run owner-approved scripts on this computer with controlled agent access.</td>
      <td>
        <input type="checkbox" role="switch" aria-label="Host tasks" bind:checked={enabled}
          disabled={!features || busy} onchange={(event) => void toggle(event.currentTarget.checked)} />
      </td>
    </tr></tbody>
  </table>
  <p class="hint">Turning off Host tasks hides its UI and blocks new requests. Existing scripts, permissions, and history are retained.</p>
  <button disabled={busy} onclick={() => void load()}>Refresh features</button>
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  section { display: grid; gap: 12px; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 12px; border-bottom: 1px solid var(--vscode-panel-border, #444); vertical-align: middle; }
  th:last-child, td:last-child { text-align: center; width: 80px; }
  small { display: block; font-weight: normal; color: var(--desktop-chat-muted); }
  .hint { font-size: 12px; color: var(--desktop-chat-muted); }
  input { appearance: none; width: 36px; height: 20px; border-radius: 12px; background: var(--vscode-input-background, #555); border: 1px solid var(--vscode-input-border, #888); position: relative; cursor: pointer; }
  input::before { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--vscode-foreground, #eee); }
  input:checked { background: var(--vscode-button-background, #0078d4); }
  input:checked::before { left: 18px; }
  input:disabled { opacity: 0.5; cursor: default; }
  input:focus-visible { outline: 2px solid var(--vscode-focusBorder, #0078d4); outline-offset: 2px; }
</style>
