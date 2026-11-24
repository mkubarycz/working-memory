<script lang="ts">
  import { onMount } from 'svelte';
  import type { ChatBugReportDraft, FeedbackPreparation, FeedbackSendResult, PublicFeedbackSettings } from '../shared/contracts';
  import ShareTopicDialog from './ShareTopicDialog.svelte';
  import PopupFrame from './PopupFrame.svelte';

  let { capture, evidenceDescription, supportingEvidence, onClose, sessionOnly = false, prepareCapture, compact = false }: {
    capture: (description: string) => Promise<ChatBugReportDraft>;
    evidenceDescription: string;
    supportingEvidence?: string;
    onClose: () => void;
    sessionOnly?: boolean;
    prepareCapture?: () => Promise<void>;
    compact?: boolean;
  } = $props();
  let dialog = $state<HTMLDialogElement>();
  let description = $state('');
  let creating = $state(false);
  let copying = $state(false);
  let copied = $state(false);
  const busy = $derived(creating || copying);
  let error = $state('');
  let report = $state<ChatBugReportDraft | null>(null);
  let result = $state<FeedbackSendResult | null>(null);
  let showPreview = $state(false);
  let preparation = $state<FeedbackPreparation | null>(null);
  let deliverySettings = $state<PublicFeedbackSettings | null>(null);
  let deliveryError = $state('');
  let captureInitialized = $state(false);
  const captureReady = $derived(!prepareCapture || captureInitialized);
  let captureError = $state('');
  let preparingCapture = $state(false);
  const requestId = crypto.randomUUID();
  let mounted = true;
  onMount(() => {
    if (!dialog) throw new Error('The bug report dialog is unavailable.');
    dialog.showModal();
    void loadDeliverySettings();
    if (prepareCapture) void initializeCapture();
    return () => { mounted = false; };
  });

  async function initializeCapture(): Promise<void> {
    preparingCapture = true;
    captureError = '';
    try {
      await prepareCapture?.();
      if (mounted) captureInitialized = true;
    } catch (cause) {
      if (mounted) captureError = `Could not capture session diagnostics: ${cause instanceof Error ? cause.message : String(cause)}`;
    } finally { if (mounted) preparingCapture = false; }
  }

  async function loadDeliverySettings(): Promise<void> {
    deliveryError = '';
    try {
      const settings = await window.workingMemory.getPublicFeedbackSettings();
      if (mounted) deliverySettings = settings;
    } catch (cause) {
      if (mounted) deliveryError = `Could not check the report delivery route: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  async function createReport(previewOnly = false): Promise<void> {
    if (busy || result || !description.trim() || !captureReady || !deliverySettings) return;
    creating = true;
    copied = false;
    error = '';
    try {
      const captured = report ?? await capture(description);
      if (!mounted) return;
      report = captured;
      if (previewOnly) {
        showPreview = true;
        return;
      }
      if (!preparation) {
        const prepared = await window.workingMemory.prepareFeedback(captured.id, requestId);
        if (!mounted) return;
        preparation = prepared;
      }
      const sent = await window.workingMemory.sendFeedback(captured.id, requestId);
      if (!mounted) return;
      result = sent;
    } catch (reason) {
      if (mounted) error = reason instanceof Error ? reason.message : String(reason);
    } finally { if (mounted) creating = false; }
  }

  async function copyReport(): Promise<void> {
    if (busy || !description.trim() || !captureReady) return;
    copying = true;
    copied = false;
    error = '';
    try {
      const captured = report ?? await capture(description);
      await navigator.clipboard.writeText(captured.body);
      if (mounted) copied = true;
    } catch (reason) {
      if (mounted) error = `Could not copy bug report: ${reason instanceof Error ? reason.message : String(reason)}`;
    } finally { if (mounted) copying = false; }
  }
</script>

{#snippet reportContent()}
    {#if result && !compact}
      <p role="status">Report uploaded to {result.destination}. Queued for the Feedback receiver; import and topic status are not confirmed.</p>
      {#if sessionOnly}<p>No topic was created on the affected backend.</p>{/if}
    {:else}
    <label for="bug-description">What was the bug?</label>
    <textarea id="bug-description" bind:value={description} maxlength="8000" rows="5"
      disabled={busy || !!report} oninput={() => { copied = false; }} placeholder="What went wrong, and what did you expect to happen?"></textarea>
    {#if preparingCapture}<p role="status">Collecting session diagnostics…</p>{/if}
    {#if captureError}<p class="error" role="alert">{captureError}
      <button onclick={() => void initializeCapture()}>Retry diagnostic capture</button></p>{/if}
    {#if supportingEvidence && !compact}
      <section class="supporting-evidence" aria-label="Supporting evidence">
        <h3>Supporting evidence</h3>
        <pre>{supportingEvidence}</pre>
      </section>
    {/if}
    <div class="warning" role="note">
      {#if compact}
        {#if deliverySettings?.enabled}
          Encrypted public inbox: {deliverySettings.destination}
        {:else if deliverySettings}
          Connect this computer in Settings &gt; Feedback and ask the owner to approve it.
        {:else}
          Checking delivery route…
        {/if}
      {:else}
      {#if deliverySettings?.enabled}
        Public delivery is enabled: reports are uploaded to Azure at {deliverySettings.destination},
        encrypted for the configured recipient, and queued until the receiver imports them.
      {:else if deliverySettings}
        Connect this computer in Settings &gt; Feedback and ask the owner to approve it before sending.
      {:else}
        Checking the configured report delivery route…
      {/if}
      Reports use approved-device HTTPS upload only. There is no local-network fallback.
      {/if}
    </div>
    {#if deliveryError}<p class="error" role="alert">{deliveryError}
      <button onclick={() => void loadDeliverySettings()}>Retry delivery settings</button></p>{/if}
    {#if !compact}<details class="report-details">
      <summary>Report details</summary>
      <div>{evidenceDescription}</div>
      <div>Known credentials and recognized secret fields are redacted. Do not include private information.
        Preview the report before sharing. Prompt images are referenced, not uploaded; other conversations and general log files are not included.</div>
      <div>{sessionOnly
        ? 'This report can be sent even when the backend is offline. It is not saved as a topic; canceling discards the preview.'
        : 'A local report topic is kept if sending fails. Reporting does not interrupt or change the operation.'}</div>
    </details>{/if}
    {/if}
    {#if report && !compact}
      <details><summary>Collected report</summary><pre>{report.body}</pre></details>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if compact && result}<p role="status">Bug report queued.</p>{/if}
    {#if compact && copied}<p role="status">Copied to clipboard.</p>{/if}
    {#if !compact}<footer>
      {#if result}
        <button class="primary" onclick={onClose}>Done</button>
      {:else}
        <button onclick={onClose} disabled={creating}>Cancel</button>
        <button onclick={() => void createReport(true)} disabled={creating || !description.trim() || !deliverySettings || !captureReady}>Preview report</button>
        <button class="primary" onclick={() => void createReport()} disabled={creating || !description.trim() || !deliverySettings || !captureReady}>
          {creating ? 'Sending bug report…' : 'Send bug report'}
        </button>
      {/if}
    </footer>{/if}
{/snippet}

{#snippet reportActions()}
  <button class="popup-action-button" onclick={() => void copyReport()} aria-label="Copy to clipboard"
    title={copying ? 'Copying…' : 'Copy to clipboard'} aria-busy={copying}
    disabled={busy || !description.trim() || !captureReady}>
    <span class="codicon" class:codicon-loading={copying} class:codicon-copy={!copying}
      class:codicon-modifier-spin={copying} aria-hidden="true"></span>
  </button>
  <button class="popup-action-button" onclick={() => void createReport()} aria-label="Send bug report"
    title={creating ? 'Sending bug report…' : 'Send bug report'} aria-busy={creating}
    disabled={busy || !!result || !description.trim() || !deliverySettings || !captureReady}>
    <span class="codicon" class:codicon-loading={creating} class:codicon-send={!creating}
      class:codicon-modifier-spin={creating} aria-hidden="true"></span>
  </button>
{/snippet}

{#if report && showPreview && !compact}
  <ShareTopicDialog topic={report} preview={report.body} {requestId}
    {preparation}
    sessionOnly={report.sessionOnly ?? false} beforeShare={() => Promise.resolve()} {onClose} />
{:else}
  <dialog bind:this={dialog} aria-labelledby="report-bug-title"
    class:popup-dialog={compact} class:legacy-report-dialog={!compact}
    oncancel={event => { event.preventDefault(); if (!busy) onClose(); }}>
    {#if compact}
      <PopupFrame title="Bug Report" titleId="report-bug-title" {onClose} closeLabel="Close bug report"
        {busy} actions={reportActions}>
        {@render reportContent()}
      </PopupFrame>
    {:else}
      <h2 id="report-bug-title">Bug Report</h2>
      {@render reportContent()}
    {/if}
  </dialog>
{/if}

<style>
  .legacy-report-dialog { width: min(560px, 85vw); border: 1px solid #bcb7bc; border-radius: 8px; padding: 22px; color: #29252a; background: #faf9f7; }
  .legacy-report-dialog::backdrop { background: #0006; }
  h2 { margin-top: 0; }
  label { display: block; font-weight: 600; margin-bottom: 8px; }
  label[for="bug-description"] { margin-top: 8px; }
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
  footer button, .error button { padding: 7px 14px; }
  .primary { background: var(--desktop-accent-strong, #51465c); color: white; border: 1px solid transparent; border-radius: 4px; }
  .primary:disabled { opacity: 0.5; }
</style>
