<script lang="ts">
  import type { ChatRun } from './chatHistory';
  import ReportBugDialog from './ReportBugDialog.svelte';

  let { run, conversationBlocked, localRequestActive, onClose }: {
    run: ChatRun; conversationBlocked: boolean; localRequestActive: boolean; onClose: () => void;
  } = $props();
</script>

<ReportBugDialog {onClose}
  evidenceDescription="Includes this message's prompt, response, tool calls/results, journal logs, status and local run diagnostics. You can report a message that is still running."
  capture={description => window.workingMemory.createChatBugReport({
    description, run: $state.snapshot(run), renderer: { conversationBlocked, localRequestActive },
  })} />
