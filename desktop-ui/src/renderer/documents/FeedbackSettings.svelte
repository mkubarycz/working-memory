<script lang="ts">
  import { onMount } from 'svelte';
  import type { PublicFeedbackSettings } from '../../shared/contracts';

  let settings = $state<PublicFeedbackSettings | null>(null);
  let configuration = $state('');
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  onMount(() => { void load(); });

  async function load(): Promise<void> {
    try { settings = await window.workingMemory.getPublicFeedbackSettings(); }
    catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
  }

  async function save(clear = false): Promise<void> {
    busy = true;
    error = '';
    message = '';
    try {
      settings = clear ? await window.workingMemory.clearPublicFeedbackSettings()
        : await window.workingMemory.savePublicFeedbackSettings(JSON.parse(configuration));
      configuration = '';
      message = clear ? 'Public inbox disabled. Feedback will use local network discovery.'
        : 'Public inbox saved. Reports will be encrypted for its recipient before upload.';
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally { busy = false; }
  }
</script>

<section aria-label="Feedback settings">
  <h2>Bug report delivery</h2>
  <p>Use a public write-only inbox when the receiving computer is not reachable from this network.
    Reports are encrypted for the Feedback receiver before they leave this computer.
    Uploading queues a report; it does not confirm import into Working Memory.</p>
  {#if settings?.enabled}
    <p>Public inbox: <strong>{settings.destination}</strong></p>
  {:else if settings}
    <p>Using local network Feedback discovery.</p>
  {/if}
  <label for="public-feedback-configuration">Public inbox sender configuration</label>
  <textarea id="public-feedback-configuration" bind:value={configuration} rows="6"
    autocomplete="off" spellcheck="false" disabled={busy}
    placeholder="Paste the sender configuration created by the public inbox setup script."></textarea>
  <p>The create-only upload credential is encrypted in your desktop credential vault.
    Never paste the receiver's private key or read/delete credential here.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <div>
    <button onclick={() => void save()} disabled={busy || !configuration.trim()}>Save public inbox</button>
    <button onclick={() => void save(true)} disabled={busy}>Use local network instead</button>
  </div>
</section>

<style>
  section { max-width: 720px; }
  p { line-height: 1.5; }
  label { display: block; margin-bottom: 8px; font-weight: 600; }
  textarea { box-sizing: border-box; width: 100%; font-family: monospace; }
  button { margin: 12px 8px 0 0; }
  .error { color: #91251f; }
</style>
