<script lang="ts">
  import { onMount } from 'svelte';
  import type { InstanceFeatures } from '../../../../control-plane/src/instanceFeatures';

  let { onChanged }: { onChanged: (features: InstanceFeatures) => void } = $props();
  let features = $state<InstanceFeatures | null>(null);
  let enabled = $state(false);
  let busy = $state(false);
  let error = $state('');
  let pollError = $state('');
  let active = false;
  let refreshing = false;
  let generation = 0;

  async function load(): Promise<void> {
    if (!active || refreshing || busy) return;
    refreshing = true;
    const current = generation;
    try {
      const loaded = await window.workingMemory.getInstanceFeatures();
      if (!active || current !== generation) return;
      features = loaded;
      enabled = features.hostTasks;
      pollError = '';
      onChanged(features);
    } catch (cause) {
      if (active && current === generation) pollError = cause instanceof Error ? cause.message : String(cause);
    } finally { refreshing = false; }
  }
  async function toggle(requested: boolean): Promise<void> {
    if (!active || busy || !features) return;
    busy = true;
    generation += 1;
    error = '';
    try {
      const saved = await window.workingMemory.setInstanceFeatures({ hostTasks: requested });
      if (!active) return;
      features = saved;
      onChanged(features);
    } catch (cause) { if (active) error = cause instanceof Error ? cause.message : String(cause); }
    finally { enabled = features?.hostTasks ?? false; busy = false; }
  }
  onMount(() => {
    active = true;
    void load();
    const timer = setInterval(() => void load(), 2000);
    return () => { active = false; generation += 1; clearInterval(timer); };
  });
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
        <input class="feature-switch" type="checkbox" role="switch" aria-label="Host tasks" bind:checked={enabled}
          disabled={!features || busy} onchange={(event) => void toggle(event.currentTarget.checked)} />
      </td>
    </tr></tbody>
  </table>
  <p class="hint">Turning off Host tasks hides its UI and blocks new requests. Existing scripts, permissions, and history are retained.</p>
  {#if error || pollError}<p role="alert">{error || pollError}</p>{/if}
</section>

<style>
  section { display: grid; gap: 12px; }
  table { width: 100%; border-collapse: collapse; text-align: left; }
  th, td { padding: 12px; border-bottom: 1px solid var(--vscode-panel-border, #444); vertical-align: middle; }
  th:last-child, td:last-child { text-align: center; width: 80px; }
  small { display: block; font-weight: normal; color: var(--desktop-chat-muted); }
  .hint { font-size: 12px; color: var(--desktop-chat-muted); }
  .feature-switch {
    appearance: none; box-sizing: border-box; display: inline-block; vertical-align: middle;
    width: 40px; height: 24px; padding: 0; margin: 0;
    border: 1px solid transparent; border-radius: 999px; background: #8f8992;
    position: relative; cursor: pointer; transition: background-color 140ms ease;
  }
  .feature-switch::before {
    content: ''; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px;
    border-radius: 50%; background: #fff; box-shadow: 0 1px 2px #0003;
    transition: transform 140ms ease;
  }
  .feature-switch:checked { background: var(--desktop-accent-strong, #bd1f66); }
  .feature-switch:checked::before { transform: translateX(16px); }
  .feature-switch:focus { box-shadow: none; }
  .feature-switch:focus-visible { outline: 2px solid var(--vscode-focusBorder, #bd1f66); outline-offset: 3px; }
  .feature-switch:disabled { opacity: 0.5; cursor: default; }
  @media (prefers-reduced-motion: reduce) {
    .feature-switch, .feature-switch::before { transition: none; }
  }
</style>
