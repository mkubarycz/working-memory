<script lang="ts">
  import type { ChatRun } from './chatHistory';
  import type { AgentMessageVM, DocumentVM } from './documents/types';
  import type { ScopedChatContext } from './scopedChat';
  import { mergeMessageRows, scopedMessageRows, messageNeedsAttention } from './agentMessages';
  import MessageEntry, { type MessageEntryProps } from './MessageEntry.svelte';

  let {
    runs, agentMessages, scoped = false, context, document, limit,
    expanded = true, ...entryProps
  }: Omit<MessageEntryProps, 'row' | 'latest'> & {
    runs: ChatRun[];
    agentMessages: AgentMessageVM[];
    scoped?: boolean;
    context?: ScopedChatContext;
    document?: DocumentVM | null;
    limit?: number;
  } = $props();

  const rows = $derived(scoped
    ? scopedMessageRows(runs, agentMessages, context, document)
    : mergeMessageRows(runs, agentMessages));
  // Older requests remain discoverable without rendering a second copy above the timeline.
  const visibleRows = $derived(limit === undefined ? rows : rows.filter((row, index) =>
    index >= rows.length - limit
    || (row.kind === 'agent-message' ? messageNeedsAttention(row.message) : row.run.status === 'awaiting_confirmation')));
</script>

{#each visibleRows as row, index (row.key)}
  <MessageEntry {row} {expanded} latest={index === visibleRows.length - 1} {...entryProps} />
{/each}
