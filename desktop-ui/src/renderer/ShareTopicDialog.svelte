<script lang="ts">
  import { onMount } from 'svelte';
  import type { TopicVM } from './documents/types';
  import type { FeedbackContext, FeedbackServer } from '../shared/contracts';

  let { topic, beforeShare, onClose }: { topic: TopicVM; beforeShare: () => Promise<void>; onClose: () => void } = $props();
  let dialog: HTMLDialogElement;
  let servers = $state<FeedbackServer[]>([]);
  let context = $state<FeedbackContext | null>(null);
  let selectedServerId = $state('');
  let phase = $state<'preparing' | 'sending' | null>(null);
  const busy = $derived(phase !== null);
  let error = $state('');
  let message = $state('');
  let sent = $state(false);
  const requestId = crypto.randomUUID();

  onMount(() => {
    dialog.showModal();
    void prepare();
  });

  async function prepare(): Promise<void> {
    if (!topic.id || busy || sent) return;
    const previousServerId = selectedServerId;
    selectedServerId = '';
    servers = [];
    phase = 'preparing';
    error = '';
    try {
      await beforeShare();
      const result = await window.workingMemory.prepareFeedback(topic.id, requestId);
      servers = result.servers;
      context = result.context;
      selectedServerId = servers.length === 1 ? servers[0].id
        : servers.some(server => server.id === previousServerId) ? previousServerId : '';
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally { phase = null; }
  }

  async function send(): Promise<void> {
    if (!topic.id || busy || sent || !selectedServerId) return;
    phase = 'sending';
    error = '';
    message = '';
    try {
      const result = await window.workingMemory.sendFeedback(topic.id, requestId, selectedServerId);
      if (result.status === 'choose') { servers = result.servers; selectedServerId = ''; return; }
      sent = true;
      message = `${result.receipt.duplicate ? 'Already received' : 'Feedback sent'} to Inbox: ${result.receipt.title}`;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally { phase = null; }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="share-topic-title" oncancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
  <h2 id="share-topic-title">Send Feedback</h2>
  <p><strong>{topic.title}</strong></p>
  <p>{phase === 'preparing' ? 'Preparing screenshots and discovering Feedback servers...'
    : phase === 'sending' ? 'Sending feedback over encrypted HTTPS...'
    : sent ? 'A copy was sent and a dated tracking link was added to the original topic.'
    : 'Click Send to send a copy. A dated tracking link will be added to the original topic after delivery.'}</p>
  {#if context}
    <dl aria-label="Included version details">
      <dt>Working Memory</dt><dd>{context.desktop.version}</dd>
      <dt>Desktop build</dt><dd>{context.desktop.build}</dd>
      <dt>Selected backend version</dt><dd>{context.backend.version}</dd>
    </dl>
  {/if}
  {#if !sent && servers.length > 1}
    <p>Choose a Feedback server:</p>
    {#each servers as server (server.id)}
      <label><input type="radio" bind:group={selectedServerId} value={server.id} disabled={busy} /> {server.name} — {server.address}</label>
    {/each}
  {/if}
  <p class="warning">Trusted LAN only. Traffic is encrypted with the discovered server's self-signed certificate; servers and senders are not authenticated.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <footer>
    {#if !sent}<button onclick={onClose} disabled={busy}>Cancel</button>{/if}
    {#if error}<button onclick={() => void prepare()} disabled={busy}>Refresh servers</button>{/if}
    <button class="primary" onclick={() => sent ? onClose() : void send()} disabled={busy || (!sent && !selectedServerId)}>
      {sent ? 'Done' : phase === 'sending' ? 'Sending...' : 'Send'}
    </button>
  </footer>
</dialog>

<style>
  dialog { width: min(480px, 85vw); border: 1px solid #bcb7bc; border-radius: 8px; padding: 22px; color: #29252a; background: #faf9f7; }
  dialog::backdrop { background: #0006; }
  h2 { margin-top: 0; }
  p { font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
  .warning { color: #765014; }
  .error { color: #91251f; }
  footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
  button { padding: 7px 14px; }
  .primary { background: var(--desktop-accent-strong, #51465c); color: white; border: 1px solid transparent; border-radius: 4px; }
  .primary:disabled { opacity: 0.5; }
  label { display: block; margin: 8px 0; font-size: 13px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 12px; }
  dd { margin: 0; overflow-wrap: anywhere; }
</style>
