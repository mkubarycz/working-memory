<script lang="ts">
  import type { ChatRun } from './chatHistory';
  import type { AgentMessageVM, DocumentVM } from './documents/types';
  import type { ScopedChatContext } from './scopedChat';
  import { activeReminderRows, mergeMessageRows, scopedMessageRows, messageNeedsAttention } from './agentMessages';
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
  const reminders = $derived(activeReminderRows(rows));
  const reminderKeys = $derived(new Set(reminders.map((row) => row.key)));
  const historyRows = $derived(rows.filter((row) => !reminderKeys.has(row.key)));
  // Older requests remain discoverable without rendering a second copy above the timeline.
  const visibleRows = $derived(limit === undefined ? historyRows : historyRows.filter((row, index) =>
    index >= historyRows.length - limit
    || (row.kind === 'agent-message' ? messageNeedsAttention(row.message) : row.run.status === 'awaiting_confirmation')));
</script>

{#if reminders.length}
  <section aria-label="Reminders" class="reminder-list">
    <h3>Reminders</h3>
    {#each reminders as row (row.key)}
      <MessageEntry {row} {expanded} {...entryProps} />
    {/each}
  </section>
{/if}
{#each visibleRows as row, index (row.key)}
  <MessageEntry {row} {expanded} latest={index === visibleRows.length - 1} {...entryProps} />
{/each}
