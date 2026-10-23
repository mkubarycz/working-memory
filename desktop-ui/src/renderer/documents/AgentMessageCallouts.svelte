<script lang="ts">
  import type { AgentMessageVM, RecordAgentMessageDecision } from './types';
  import AgentMessageCard from './AgentMessageCard.svelte';
  let { agentMessages, onSetAgentMessageStatus, onRecordDecision, attachmentBaseUrl = '' }: {
    agentMessages: AgentMessageVM[];
    onSetAgentMessageStatus: (id: string, status: AgentMessageVM['status']) => void;
    onRecordDecision?: RecordAgentMessageDecision;
    attachmentBaseUrl?: string;
  } = $props();
</script>

{#if agentMessages.length}
  <section aria-label="Agent messages">
    {#each agentMessages as message (message.id)}
      <AgentMessageCard {message} onSetStatus={onSetAgentMessageStatus} {onRecordDecision} {attachmentBaseUrl} />
    {/each}
  </section>
{/if}
