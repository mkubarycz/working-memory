<script lang="ts">
  import { onMount } from 'svelte';
  import type { TopicVM } from './documents/types';
  import type { FeedbackPreparation } from '../shared/contracts';
  let { topic, beforeShare, onClose, preview, sessionOnly = false, requestId = crypto.randomUUID(), preparation = null }: {
    topic: Pick<TopicVM, 'id' | 'title'>; beforeShare: () => Promise<void>; onClose: () => void; preview?: string;
    sessionOnly?: boolean; requestId?: string; preparation?: FeedbackPreparation | null;
  } = $props();
  let dialog: HTMLDialogElement;
  let prepared = $state<FeedbackPreparation | null>(null);
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let sent = $state(false);
  onMount(() => {
    dialog.showModal();
    if (preparation) prepared = preparation;
    else void prepare();
  });
  async function prepare(): Promise<void> {
    busy = true;
    error = '';
    try {
      await beforeShare();
      prepared = await window.workingMemory.prepareFeedback(topic.id, requestId);
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; }
  }
  async function send(): Promise<void> {
    if (busy || sent || !prepared) return;
    busy = true;
    error = '';
    try {
      const result = await window.workingMemory.sendFeedback(topic.id, requestId);
      sent = true;
      message = `Report uploaded to ${result.destination}. Queued for the Feedback receiver; import and topic status are not confirmed.`;
    } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    finally { busy = false; }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="share-topic-title" oncancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
  <h2 id="share-topic-title">Send Feedback</h2>
  <p><strong>{topic.title}</strong></p>
  {#if preview}<details><summary>Review the report before sharing</summary><pre>{preview}</pre></details>{/if}
  <p>{busy ? 'Preparing or uploading encrypted feedback...' : 'A copy is encrypted for the receiver and queued over HTTPS. The original topic is not changed.'}</p>
  {#if prepared}
    <dl aria-label="Included version details">
      <dt>Working Memory</dt><dd>{prepared.context.desktop.version}</dd>
      <dt>Desktop build</dt><dd>{prepared.context.desktop.build}</dd>
      <dt>{sessionOnly ? 'Backend version before operation' : 'Selected backend version'}</dt><dd>{prepared.context.backend.version}</dd>
    </dl>
  {/if}
  <p>One-time device approval is managed in Settings &gt; Feedback. No local-network fallback is used.</p>
  {#if sessionOnly}<p>No topic is written to the affected backend.</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if message}<p role="status">{message}</p>{/if}
  <footer>
    {#if !sent}<button onclick={onClose} disabled={busy}>Cancel</button>{/if}
    {#if error && !prepared}<button onclick={() => void prepare()} disabled={busy}>Retry preparation</button>{/if}
    <button onclick={() => sent ? onClose() : void send()} disabled={busy || (!sent && !prepared)}>{sent ? 'Done' : 'Send'}</button>
  </footer>
</dialog>

<style>
  dialog { width: min(480px, 85vw); border: 1px solid #bcb7bc; border-radius: 8px; padding: 22px; color: #29252a; background: #faf9f7; }
  dialog::backdrop { background: #0006; }
  p { font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
  .error { color: #91251f; }
  footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
  button { padding: 7px 14px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; font-size: 12px; }
  dd { margin: 0; overflow-wrap: anywhere; }
  pre { max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
</style>
