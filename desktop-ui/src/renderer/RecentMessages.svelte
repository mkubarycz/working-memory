<script lang="ts">
  import type { ChatRun } from './chatHistory';
  import type { ScopedChatContext } from './scopedChat';
  import type { AgentMessageVM, DocumentVM } from './documents/types';
  import type { MessageEntryProps } from './MessageEntry.svelte';
  import { scopedMessageRows } from './agentMessages';
  import MessageTimeline from './MessageTimeline.svelte';

  let {
    runs, context, expanded = $bindable(false), loading = false, error = '',
    onReload, agentMessages = [], document, ...entryProps
  }: Omit<MessageEntryProps, 'row' | 'latest' | 'expanded' | 'onSetAgentMessageStatus'> & {
    runs: ChatRun[];
    context: ScopedChatContext | undefined;
    expanded?: boolean;
    loading?: boolean;
    error?: string;
    onReload: () => void;
    agentMessages?: AgentMessageVM[];
    document?: DocumentVM | null;
    onSetAgentMessageStatus: MessageEntryProps['onSetAgentMessageStatus'];
  } = $props();

  const allRows = $derived(scopedMessageRows(runs, agentMessages, context, document));
</script>

<section class="scope-preview" class:expanded aria-label="Recent messages">
  <div class="scope-preview-heading">
    <span>Recent messages</span>
    {#if context}
      <button aria-expanded={expanded} aria-controls="scoped-messages"
        onclick={() => (expanded = !expanded)}>
        {expanded ? 'Collapse messages' : 'Expand for all messages and details'}
        <span aria-hidden="true" class="codicon codicon-chevron-{expanded ? 'down' : 'up'}"></span>
      </button>
    {/if}
  </div>
  {#if !context}
    <p>No document selected. View all conversations in the Log.</p>
  {:else}
    <div class="scope-preview-history">
      {#if loading}<p role="status">Loading messages…</p>{/if}
      {#if error}<div class="history-error" role="alert">{error} <button onclick={onReload}>Retry loading messages</button></div>{/if}
      <div id="scoped-messages">
        {#if allRows.length === 0 && !loading && !error}
          <p>No messages for this scope.</p>
        {/if}
        <MessageTimeline {runs} {agentMessages} scoped {context} {document}
          {expanded} limit={expanded ? undefined : 5}
          showScope={false} showInLog {...entryProps} />
      </div>
    </div>
  {/if}
</section>
