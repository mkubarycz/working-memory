<script lang="ts">
  import { onMount } from 'svelte';
  import type { ChatBugReportDraft, FeedbackSendResult } from '../shared/contracts';
  import ShareTopicDialog from './ShareTopicDialog.svelte';

  let { capture, evidenceDescription, supportingEvidence, onClose, sessionOnly = false }: {
    capture: (description: string) => Promise<ChatBugReportDraft>;
    evidenceDescription: string;
    supportingEvidence?: string;
    onClose: () => void;
    sessionOnly?: boolean;
  } = $props();
  let dialog = $state<HTMLDialogElement>();
  let description = $state('');
  let creating = $state(false);
  let error = $state('');
  let report = $state<ChatBugReportDraft | null>(null);
  let result = $state<Exclude<FeedbackSendResult, { status: 'choose' }> | null>(null);
  let chooseServer = $state(false);
  let preparedServerId = '';
  const requestId = crypto.randomUUID();
  let mounted = true;
  onMount(() => {
    if (!dialog) throw new Error('The bug report dialog is unavailable.');
    dialog.showModal();
    return () => { mounted = false; };
  });

  async function createReport(previewOnly = false): Promise<void> {
    if (creating || !description.trim()) return;
    creating = true;
    error = '';
    try {
      const captured = report ?? await capture(description);
      if (!mounted) return;
      report = captured;
      if (previewOnly) {
        chooseServer = true;
        return;
      }
      if (!preparedServerId) {
        const preparation = await window.workingMemory.prepareFeedback(captured.id, requestId);
        if (!mounted) return;
        if (preparation.servers.length !== 1) {
          chooseServer = true;
          return;
        }
        preparedServerId = preparation.servers[0].id;
      }
      const sent = await window.workingMemory.sendFeedback(captured.id, requestId, preparedServerId);
      if (!mounted) return;
      if (sent.status === 'choose') chooseServer = true;
      else result = sent;
    } catch (reason) {
      if (mounted) error = reason instanceof Error ? reason.message : String(reason);
    } finally { if (mounted) creating = false; }
  }
</script>

{#if report && chooseServer}
  <ShareTopicDialog topic={report} preview={report.body} {requestId}
    sessionOnly={report.sessionOnly ?? false} beforeShare={() => Promise.resolve()} {onClose} />
{:else}
  <dialog bind:this={dialog} aria-labelledby="report-bug-title"
    oncancel={event => { event.preventDefault(); if (!creating) onClose(); }}>
    <h2 id="report-bug-title">Bug Report</h2>
    {#if result}
      <p role="status">{result.status === 'queued'
        ? `Report uploaded to ${result.destination}. Queued for the Feedback receiver; import and topic status are not confirmed.`
        : `Bug report sent to Inbox: ${result.receipt.title}`}</p>
      {#if result.status === 'sent'}
        <p><a href={result.receipt.statusUrl} target="_blank" rel="noreferrer">Check report status</a></p>
      {/if}
      {#if sessionOnly}<p>No topic was created on the affected backend.</p>{/if}
    {:else}
    <label for="bug-description">What was the bug?</label>
    <textarea id="bug-description" bind:value={description} maxlength="8000" rows="5"
      disabled={creating || !!report} placeholder="What went wrong, and what did you expect to happen?"></textarea>
    {#if supportingEvidence}
      <section class="supporting-evidence" aria-label="Supporting evidence">
        <h3>Supporting evidence</h3>
        <pre>{supportingEvidence}</pre>
      </section>
    {/if}
    <div class="warning" role="note">Trusted LAN only. Traffic is encrypted with the discovered server's self-signed certificate; servers and senders are not authenticated.</div>
    <details class="report-details">
      <summary>Report details</summary>
      <div>{evidenceDescription}</div>
      <div>Known credentials and recognized secret fields are redacted. Do not include private information.
        Preview the report before sharing. Prompt images are referenced, not uploaded; other conversations and general log files are not included.</div>
      <div>{sessionOnly
        ? 'This report can be sent even when the backend is offline. It is not saved as a topic; canceling discards the preview.'
        : 'A local report topic is kept if sending fails. Reporting does not interrupt or change the operation.'}</div>
    </details>
    {/if}
    {#if report}
      <details><summary>Collected report</summary><pre>{report.body}</pre></details>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      {#if result}
        <button class="primary" onclick={onClose}>Done</button>
      {:else}
        <button onclick={onClose} disabled={creating}>Cancel</button>
        <button onclick={() => void createReport(true)} disabled={creating || !description.trim()}>Preview report</button>
        <button class="primary" onclick={() => void createReport()} disabled={creating || !description.trim()}>
          {creating ? 'Sending bug report…' : 'Send bug report'}
        </button>
      {/if}
    </footer>
  </dialog>
{/if}

<style>
  dialog { width: min(560px, 85vw); border: 1px solid #bcb7bc; border-radius: 8px; padding: 22px; color: #29252a; background: #faf9f7; }
  dialog::backdrop { background: #0006; }
  h2 { margin-top: 0; }
  label { display: block; font-weight: 600; margin-bottom: 8px; }
  textarea { box-sizing: border-box; width: 100%; padding: 8px; resize: vertical; font: inherit; }
  p { font-size: 13px; line-height: 1.5; }
  h3 { margin: 12px 0 6px; font-size: 14px; }
  .supporting-evidence pre { margin: 0; max-height: 24vh; }
  .report-details { margin-top: 12px; font-size: 12px; line-height: 1.5; }
  .report-details div { margin-top: 8px; }
  .warning { margin-top: 12px; color: #765014; font-size: 12px; line-height: 1.5; }
  .error { color: #91251f; }
  pre { max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
  footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
  button { padding: 7px 14px; }
  .primary { background: var(--desktop-accent-strong, #51465c); color: white; border: 1px solid transparent; border-radius: 4px; }
  .primary:disabled { opacity: 0.5; }
</style>
