<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import HostScripts from '../HostScripts.svelte';
  import type { InstanceFeatures } from '../../../../control-plane/src/instanceFeatures';

  let { onChanged }: { onChanged: (features: InstanceFeatures) => void } = $props();
  let features = $state<InstanceFeatures | null>(null);
  let connected = $state(false);
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
    } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
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
  <p>Features are saved on the selected control-plane instance and shared by all its clients.
    Sign in as the instance owner to change them.</p>
  <HostScripts connectionOnly onConnectionChanged={(value) => { connected = value; }} />
  <label>
    <input type="checkbox" bind:checked={enabled} disabled={!features || !connected || busy}
      onchange={(event) => void toggle(event.currentTarget.checked)} />
    Host tasks (experimental)
  </label>
  <p>Off by default. Enables approved host scripts, caller permissions, and the desktop runner.
    Turning it off hides the Host tasks tab entry and blocks host-task HTTP/MCP requests with a feature-disabled error.
    Existing scripts, grants, and history are retained.</p>
  <button disabled={busy} onclick={() => void load()}>Refresh features</button>
  {#if error}<p role="alert">{error}</p>{/if}
</section>

<style>
  section { display: grid; gap: 12px; }
  label { display: flex; align-items: center; gap: 8px; }
  input { width: auto; }
</style>
