<script lang="ts">
  import { onMount } from 'svelte';
  import type { ChatBugReportDraft } from '../shared/contracts';
  import ShareTopicDialog from './ShareTopicDialog.svelte';

  let { capture, evidenceDescription, onClose, sessionOnly = false }: {
    capture: (description: string) => Promise<ChatBugReportDraft>;
    evidenceDescription: string;
    onClose: () => void;
    sessionOnly?: boolean;
  } = $props();
  let dialog = $state<HTMLDialogElement>();
  let description = $state('');
  let creating = $state(false);
  let error = $state('');
  let report = $state<ChatBugReportDraft | null>(null);
  let mounted = true;
  onMount(() => {
    if (!dialog) throw new Error('The bug report dialog is unavailable.');
    dialog.showModal();
    return () => { mounted = false; };
  });

  async function createReport(): Promise<void> {
    if (creating || !description.trim()) return;
    creating = true;
    error = '';
    try {
      const captured = await capture(description);
      if (mounted) report = captured;
    } catch (reason) {
      if (mounted) error = reason instanceof Error ? reason.message : String(reason);
    } finally { if (mounted) creating = false; }
  }
</script>

{#if report}
  <ShareTopicDialog topic={report} preview={report.body} sessionOnly={report.sessionOnly ?? false} beforeShare={() => Promise.resolve()} {onClose} />
{:else}
  <dialog bind:this={dialog} aria-labelledby="report-bug-title"
    oncancel={event => { event.preventDefault(); if (!creating) onClose(); }}>
    <h2 id="report-bug-title">Report a bug</h2>
    <label for="bug-description">What was the bug?</label>
    <textarea id="bug-description" bind:value={description} maxlength="8000" rows="5"
      disabled={creating} placeholder="What went wrong, and what did you expect to happen?"></textarea>
    <p>{evidenceDescription}</p>
    <p>Known credentials and recognized secret fields are redacted. Review the report before sharing.
      Prompt images are referenced, not uploaded; other conversations and general log files are not included.</p>
    <p>{sessionOnly
      ? 'This report can be sent even when the backend is offline. It is not saved as a topic; canceling discards the preview. Click Send on the next screen to publish it.'
      : 'A local report topic is created first and kept even if you cancel sending. Reporting does not interrupt or change the operation.'}</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <footer>
      <button onclick={onClose} disabled={creating}>Cancel</button>
      <button class="primary" onclick={() => void createReport()} disabled={creating || !description.trim()}>
        {creating ? 'Collecting report…' : 'Create report'}
      </button>
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
  .error { color: #91251f; }
  footer { display: flex; gap: 10px; justify-content: flex-end; margin-top: 18px; }
  button { padding: 7px 14px; }
  .primary { background: var(--desktop-accent-strong, #51465c); color: white; border: 1px solid transparent; border-radius: 4px; }
  .primary:disabled { opacity: 0.5; }
</style>
