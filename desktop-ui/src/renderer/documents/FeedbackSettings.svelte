<script lang="ts">
  import { onMount } from 'svelte';
  import type { PublicFeedbackSettings } from '../../shared/contracts';
  let settings = $state<PublicFeedbackSettings | null>(null);
  let busy = $state(false);
  let error = $state('');
  onMount(() => {
    void update('status');
    const timer = setInterval(() => { if (!busy && settings?.state === 'pending') void update('status'); }, 10_000);
    return () => clearInterval(timer);
  });
  async function update(action: 'status' | 'connect' | 'disconnect'): Promise<void> {
    busy = true;
    error = '';
    try {
      settings = action === 'connect' ? await window.workingMemory.connectPublicFeedback()
        : action === 'disconnect' ? await window.workingMemory.clearPublicFeedbackSettings()
        : await window.workingMemory.getPublicFeedbackSettings();
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; }
  }
</script>

<section aria-label="Feedback settings">
  <h2>Feedback</h2>
  <p>Reports are encrypted for the Feedback receiver before leaving this computer.
    Uploading queues a report; it does not confirm import into Working Memory.</p>
  {#if settings?.state === 'pending'}
    <p role="status">Approval pending. Give the owner this one-time code: <strong>{settings.pairingCode}</strong></p>
    <p>Expires {settings.expiresAt ? new Date(settings.expiresAt).toLocaleString() : ''}.
      The owner enters this code in the receiving computer's Feedback app &gt; Device approvals,
      after signing in with the receiving Working Memory owner password.</p>
  {:else if settings?.state === 'connected'}
    <p role="status">Connected. This computer is approved to upload encrypted reports.</p>
  {:else if settings?.state === 'revoked'}
    <p role="status">This computer's approval was revoked. Reconnect and request a new approval.</p>
  {:else if settings?.state === 'expired'}
    <p role="status">The pairing code expired. Connect again to request approval.</p>
  {:else}
    <p>Connect this computer once, then give the code to the owner to enter in the receiving computer's
      Feedback app &gt; Device approvals. No Azure credentials or configuration to paste.</p>
  {/if}
  {#if settings}<p>Service: {settings.destination}</p>{/if}
  <p>Device credentials are protected in the desktop credential vault. Disconnect revokes this device.
    There is no local-network delivery fallback.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div>
    <button onclick={() => void update('connect')} disabled={busy || settings?.state === 'connected' || settings?.state === 'pending'}>Connect this computer</button>
    <button onclick={() => void update('status')} disabled={busy}>Check approval</button>
    <button onclick={() => void update('disconnect')} disabled={busy || settings?.state === 'disconnected'}>Disconnect and revoke</button>
  </div>
</section>

<style>
  section { max-width: 720px; }
  p { line-height: 1.5; overflow-wrap: anywhere; }
  button { margin: 12px 8px 0 0; }
  .error { color: #91251f; }
</style>
