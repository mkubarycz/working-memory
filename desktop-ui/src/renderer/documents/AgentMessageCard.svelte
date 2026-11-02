<script lang="ts">
  import type { AgentMessageVM, RecordAgentMessageDecision, SnoozeAgentMessage } from './types';
  import { renderMarkdown } from './markdown';
  import { messageNeedsAttention, messageStatusActions, reminderTiming } from '../agentMessages';
  import { formatRelativeDocumentTime } from '../documentDates';
  import SnoozeReminderDialog from './SnoozeReminderDialog.svelte';
  let { message, onSetStatus, onRecordDecision, onSnooze, attachmentBaseUrl = '', embedded = false,
    compact = false, onShowDetails, detailsExpanded = false, detailsTarget }: {
    message: AgentMessageVM;
    onSetStatus: (id: string, status: AgentMessageVM['status']) => void;
    onRecordDecision?: RecordAgentMessageDecision;
    onSnooze?: SnoozeAgentMessage;
    attachmentBaseUrl?: string;
    embedded?: boolean;
    compact?: boolean;
    onShowDetails?: () => void;
    detailsExpanded?: boolean;
    detailsTarget?: string;
  } = $props();
  let recording = $state(false);
  let decidedBy = $state('');
  let now = $state(Date.now());
  let showSnooze = $state(false);
  const timing = $derived(reminderTiming(message, now));
  const timestamp = $derived(timing && message.dueAt !== undefined ? message.dueAt : message.createdAt);
  const timeText = $derived(message.status === 'resolved' ? 'Resolved'
    : message.status === 'acknowledged' ? 'Acknowledged'
    : timing?.text ?? `Received ${formatRelativeDocumentTime(message.createdAt, now)}`);
  const attention = $derived(messageNeedsAttention(message));
  const messageUrl = $derived(`working-memory://open/agent-message/${encodeURIComponent(message.id)}`);
  $effect(() => {
    void message;
    now = Date.now();
  });
  $effect(() => {
    if (message.status !== 'open') return;
    const timer = window.setInterval(() => { now = Date.now(); }, message.category === 'reminder' ? 1000 : 30_000);
    return () => window.clearInterval(timer);
  });

  $effect(() => {
    if (message.category !== 'reminder' || message.status === 'resolved') showSnooze = false;
  });

  async function recordDecision(outcome: 'approved' | 'rejected'): Promise<void> {
    if (!onRecordDecision || recording || !decidedBy.trim()) return;
    recording = true;
    try { await onRecordDecision(message.id, outcome, decidedBy.trim()); }
    finally { recording = false; }
  }
</script>

<article class="agent-message" class:embedded class:compact class:reminder={timing !== null}
  class:selected={detailsExpanded} class:overdue={timing?.overdue}
  class:needs-attention={attention} class:message-error={attention && message.severity === 'error'}
  class:message-warning={attention && message.severity === 'warning'}
  class:muted={message.status !== 'open'} data-agent-message-id={message.id}>
  <header>
    <div class="message-heading">
      {#if compact}
        <button class="message-title" title={message.title} onclick={onShowDetails} aria-expanded={detailsExpanded} aria-controls={detailsTarget}>{message.title}</button>
      {:else}
        <a href={messageUrl} title={messageUrl}>{message.title}</a>
      {/if}
    </div>
      <div class="message-meta">
        {#if !embedded}<span class="message-from">{message.agentName}</span>{/if}
        <time class="message-time" datetime={new Date(timestamp * 1000).toISOString()}
          title={`${timing ? 'Due' : 'Received'} ${new Date(timestamp * 1000).toLocaleString()}`}
          role={timing?.overdue ? 'status' : undefined}>{timeText}</time>
      </div>
  </header>
  {#if !compact}
  <div class="markdown-body">
    {#if message.description.trim()}
      {@html renderMarkdown(message.description, attachmentBaseUrl)}
    {:else}
      <p>No message content</p>
    {/if}
  </div>
  {#if message.recommendedAction}
    <strong>Recommended action</strong>
    <div class="markdown-body">{@html renderMarkdown(message.recommendedAction, attachmentBaseUrl)}</div>
  {/if}
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
        <button title="Record approved" aria-label="Record approved" disabled={recording || !decidedBy.trim()} onclick={() => void recordDecision('approved')}>
          <span class="codicon codicon-check" aria-hidden="true"></span>{#if !compact}Record approved{/if}
        </button>
        <button title="Record rejected" aria-label="Record rejected" disabled={recording || !decidedBy.trim()} onclick={() => void recordDecision('rejected')}>
          <span class="codicon codicon-close" aria-hidden="true"></span>{#if !compact}Record rejected{/if}
        </button>
      </div>
    {/if}
  {/if}
  <div class="message-actions" aria-label="Agent message status">
    {#each messageStatusActions(message.status) as action (action.status)}
      <button title={action.label} aria-label={action.label}
        class:primary-action={(message.status === 'open' && action.status === 'acknowledged')
          || (message.status === 'acknowledged' && action.status === 'resolved')}
        onclick={() => onSetStatus(message.id, action.status)}>
        <span class="codicon codicon-{action.status === 'acknowledged' ? 'verified' : action.status === 'resolved' ? 'archive' : 'discard'}" aria-hidden="true"></span>
        {#if !compact}{action.label}{/if}
      </button>
    {/each}
    {#if message.category === 'reminder' && message.status !== 'resolved' && onSnooze}
      <button title="Snooze" aria-label="Snooze" aria-haspopup="dialog" aria-expanded={showSnooze} onclick={() => { showSnooze = true; }}>
        <span class="codicon codicon-clock" aria-hidden="true"></span>{#if !compact}Snooze{/if}
      </button>
    {/if}
    {#if compact}
      <button class="show-full-alert" title="Show full alert" aria-label="Show full alert" onclick={onShowDetails} aria-expanded={detailsExpanded} aria-controls={detailsTarget}>
        <span class="codicon codicon-expand-all" aria-hidden="true"></span>
      </button>
    {/if}
  </div>
  {#if showSnooze && message.category === 'reminder' && message.status !== 'resolved' && onSnooze}
    <SnoozeReminderDialog {message} {onSnooze} onClose={() => { showSnooze = false; }} />
  {/if}
</article>

<style>
  .agent-message { border: 1px solid var(--vscode-widget-border, #555); border-left: 3px solid #a3a3a3; border-radius: 5px; padding: 10px; margin: 6px 0; overflow-wrap: anywhere; }
  .agent-message.embedded { border: 0; border-radius: 0; padding: 0; margin: 0; }
  .agent-message.needs-attention { border-left-color: var(--vscode-textLink-foreground, #3794ff); }
  .agent-message.message-warning { border-left-color: #b78308; }
  .agent-message.message-error { border-left-color: #c42b1c; }
  .agent-message.reminder { border-left-color: #a3a3a3; }
  .agent-message.overdue { border-left-color: #c42b1c; }
  .agent-message.compact { box-sizing: border-box; width: 100%; display: flex; flex-direction: column; gap: 12px; margin: 0; }
  .compact.selected { box-shadow: 0 0 0 1px var(--vscode-widget-border, #777); }
  .compact header { flex-direction: column; gap: 8px; }
  .compact .message-meta { max-width: 100%; align-self: flex-end; }
  .message-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; border: 0; padding: 0; background: transparent; font: inherit; font-weight: 600; text-align: left; color: var(--desktop-chat-fg); cursor: pointer; }
  .compact .message-actions[aria-label="Agent message status"] { margin-top: auto; }
  .show-full-alert { margin-left: auto; }
  .compact button:not(.message-title) { min-width: 30px; min-height: 30px; }
  .compact input { box-sizing: border-box; min-width: 0; max-width: 100%; }
  .message-meta { display: flex; flex-direction: column; align-items: flex-end; text-align: right; gap: 4px; max-width: 45%; flex-shrink: 0; }
  .message-time { font-weight: 600; }
  .message-meta .message-from { color: var(--vscode-descriptionForeground, #777); font-size: .8em; font-weight: normal; }
  .overdue .message-time { color: #c42b1c; }
  header { display: flex; align-items: flex-start; gap: 12px; }
  .message-heading { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; min-width: 0; }
  .message-heading { flex: 1; }
  header a { font-weight: 600; color: var(--desktop-chat-fg); text-decoration: none; }
  header span, time, .approval-notice { font-size: .85em; color: var(--vscode-descriptionForeground); }
  .muted { opacity: .75; }
  .message-actions { display: flex; flex-wrap: wrap; gap: 6px; }
  .message-actions button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  .message-actions .primary-action { background: transparent; color: var(--desktop-accent-strong, #bd1f66); border: 1px solid var(--desktop-accent-strong, #bd1f66); font-weight: 700; }
  .message-actions .primary-action:hover { border-color: var(--desktop-accent, #e83e8c); }
  .message-actions .primary-action:focus-visible { outline: 2px solid var(--desktop-accent-strong, #bd1f66); outline-offset: 2px; }
  .approval-decision { display: grid; gap: 4px; margin: 8px 0; }
  .markdown-body :global(p) { margin: 6px 0; }
</style>
