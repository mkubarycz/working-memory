<script lang="ts">
  import type { AgentMessageVM, RecordAgentMessageDecision, SnoozeAgentMessage } from './types';
  import AgentMessageCard from './AgentMessageCard.svelte';
  let { agentMessages, onSetAgentMessageStatus, onRecordDecision, onSnooze, attachmentBaseUrl = '' }: {
    agentMessages: AgentMessageVM[];
    onSetAgentMessageStatus: (id: string, status: AgentMessageVM['status']) => void;
    onRecordDecision?: RecordAgentMessageDecision;
    onSnooze?: SnoozeAgentMessage;
    attachmentBaseUrl?: string;
  } = $props();
  let selectedMessageId = $state<string | null>(null);
  const selectedMessage = $derived(agentMessages.find((message) => message.id === selectedMessageId));
  const stageId = $derived(`agent-message-stage-${agentMessages[0]?.id ?? 'empty'}`);
  $effect(() => {
    if (selectedMessageId && !selectedMessage) selectedMessageId = null;
  });
</script>

{#if agentMessages.length}
  <section class="agent-message-callouts" aria-label="Agent messages">
      <div class="agent-message-slider" role="region" aria-label="Agent message slider">
        {#each agentMessages as message (message.id)}
          <div class="agent-message-tile">
            <AgentMessageCard {message} compact detailsExpanded={selectedMessageId === message.id} detailsTarget={stageId}
              onShowDetails={() => { selectedMessageId = message.id; }}
              onSetStatus={onSetAgentMessageStatus} {onRecordDecision} {onSnooze} {attachmentBaseUrl} />
          </div>
        {/each}
      </div>
      <div id={stageId}>
      {#if selectedMessage}
        <section class="agent-message-stage" aria-label="Full agent message">
          <div class="stage-heading">
            <span>Message details</span>
            <button onclick={() => { selectedMessageId = null; }}>
              <span class="codicon codicon-collapse-all" aria-hidden="true"></span> Hide full alert
            </button>
          </div>
          {#key selectedMessage.id}
            <AgentMessageCard message={selectedMessage} onSetStatus={onSetAgentMessageStatus}
              {onRecordDecision} {onSnooze} {attachmentBaseUrl} />
          {/key}
        </section>
      {/if}
      </div>
  </section>
{/if}

<style>
  .agent-message-callouts { min-width: 0; max-width: 100%; }
  .agent-message-slider { display: flex; gap: 10px; overflow-x: auto; scroll-snap-type: x proximity; padding: 4px 2px 10px; }
  .agent-message-tile { display: flex; flex: 0 0 240px; max-width: 100%; scroll-snap-align: start; }
  .agent-message-stage { margin-bottom: 12px; }
  .stage-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--vscode-descriptionForeground, #777); font-size: .85em; }
</style>
