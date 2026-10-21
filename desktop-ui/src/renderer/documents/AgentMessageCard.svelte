<script lang="ts">
  import type { AgentMessageVM, RecordAgentMessageDecision } from './types';
  import { renderMarkdown } from './markdown';
  import { messageStatusActions } from '../agentMessages';
  let { message, onSetStatus, onRecordDecision }: {
    message: AgentMessageVM;
    onSetStatus: (id: string, status: AgentMessageVM['status']) => void;
    onRecordDecision?: RecordAgentMessageDecision;
  } = $props();
  let recording = $state(false);
  let decidedBy = $state('');

  async function recordDecision(outcome: 'approved' | 'rejected'): Promise<void> {
    if (!onRecordDecision || recording || !decidedBy.trim()) return;
    recording = true;
    try { await onRecordDecision(message.id, outcome, decidedBy.trim()); }
    finally { recording = false; }
  }
</script>

<article class="agent-message" class:muted={message.status !== 'open'} data-agent-message-id={message.id}>
  <header>
    <a href={`working-memory://open/agent-message/${encodeURIComponent(message.id)}`}>{message.title}</a>
    <span>{message.category} · {message.severity} · {message.status}</span>
    <time datetime={new Date(message.createdAt * 1000).toISOString()}>{new Date(message.createdAt * 1000).toLocaleString()}</time>
  </header>
  <div class="markdown-body">{@html renderMarkdown(message.description)}</div>
  {#if message.recommendedAction}
    <strong>Recommended action</strong>
    <div class="markdown-body">{@html renderMarkdown(message.recommendedAction)}</div>
  {/if}
  {#if message.category === 'approval'}
    <p class="approval-notice">This message is not authorization to execute an action. Review any tool action confirmation separately.</p>
    {#if message.decision}
      <section class="approval-decision" aria-label="Recorded approval decision">
        <strong>Recorded decision: {message.decision.outcome}</strong>
        <span>by {message.decision.decided_by}</span>
        {#if message.decision.decided_at !== undefined}
          <time datetime={new Date(message.decision.decided_at * 1000).toISOString()}>
            {new Date(message.decision.decided_at * 1000).toLocaleString()}
          </time>
        {/if}
        {#if message.decision.reason}<p>{message.decision.reason}</p>{/if}
      </section>
    {/if}
    {#if !message.decision && message.status !== 'resolved' && onRecordDecision}
      <label>Recorded by
        <input bind:value={decidedBy} placeholder="Display name, not proof of identity" disabled={recording} />
      </label>
      <div class="message-actions" aria-label="Record a decision, not execution authorization">
        <button disabled={recording || !decidedBy.trim()} onclick={() => void recordDecision('approved')}>Record approved</button>
        <button disabled={recording || !decidedBy.trim()} onclick={() => void recordDecision('rejected')}>Record rejected</button>
      </div>
    {/if}
  {/if}
  <div class="message-actions" aria-label="Agent message status">
    {#each messageStatusActions(message.status) as action (action.status)}
      <button onclick={() => onSetStatus(message.id, action.status)}>{action.label}</button>
    {/each}
  </div>
</article>

<style>
  .agent-message { border: 1px solid var(--vscode-widget-border, #555); border-left: 3px solid var(--vscode-textLink-foreground, #3794ff); border-radius: 5px; padding: 10px; margin: 6px 0; overflow-wrap: anywhere; }
  header { display: flex; flex-wrap: wrap; gap: 8px; }
  header a { font-weight: 600; }
  header span, time, .approval-notice { font-size: .85em; color: var(--vscode-descriptionForeground); }
  .muted { opacity: .75; }
  .message-actions { display: flex; gap: 6px; }
  .approval-decision { display: grid; gap: 4px; margin: 8px 0; }
  .markdown-body :global(p) { margin: 6px 0; }
</style>
