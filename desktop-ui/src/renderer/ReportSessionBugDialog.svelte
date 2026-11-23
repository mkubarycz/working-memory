<script lang="ts">
  import type { ChatBugReportDraft, SessionBugReportInput } from '../shared/contracts';
  import ReportBugDialog from './ReportBugDialog.svelte';

  let { snapshot, onClose }: { snapshot: SessionBugReportInput; onClose: () => void } = $props();
  let captured: ChatBugReportDraft | null = null;
</script>

<ReportBugDialog {onClose} sessionOnly
  evidenceDescription={`Includes bounded desktop-session diagnostics${snapshot.operation
    ? ` and the selected ${snapshot.operation.kind} operation's evidence` : '; no operation is selected'}.
    No document drafts, unrelated conversations, files, attachment bytes or general logs are collected.`}
  prepareCapture={async () => { captured = await window.workingMemory.captureSessionBugReport($state.snapshot(snapshot)); }}
  capture={description => {
    if (!captured) throw new Error('Session diagnostics have not been captured. Retry diagnostic capture.');
    return window.workingMemory.describeSessionBugReport(captured.id, description);
  }} />
