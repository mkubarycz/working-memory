<script lang="ts">
  import type { ChatRun, ChatTarget, ChatToolRow } from './chatHistory';
  import { isRetryableRun } from './chatHistory';
  import type { ScopedChatContext } from './scopedChat';
  import { scopedMessageRows, messagesForContext, messageNeedsAttention } from './agentMessages';
  import type { AgentMessageVM, DocumentVM, RecordAgentMessageDecision } from './documents/types';
  import AgentMessageCard from './documents/AgentMessageCard.svelte';
  import { renderMarkdown } from './markdown';
  import { humanInitials } from './humanIdentity';
  import { observeResponse, responseKey, type UnreadResponse } from './chatUnread';
  import ToolActivity from './ToolActivity.svelte';

  let {
    runs, context, expanded = $bindable(false), loading = false, error = '', humanName,
    unreadResponses, onViewed, onFocus, onRetry, runBlocked, onInspect, onOpen, attachmentUrl,
    assistantFallback, onReload, onResolve, agentMessages = [], document, onSetAgentMessageStatus = () => {}, onRecordDecision,
  }: {
    runs: ChatRun[];
    context: ScopedChatContext | undefined;
    expanded?: boolean;
    loading?: boolean;
    error?: string;
    humanName: string;
    unreadResponses: UnreadResponse[];
    onViewed: (key: string) => void;
    onFocus: (run: ChatRun) => void;
    onRetry: (run: ChatRun) => void;
    runBlocked: (run: ChatRun) => boolean;
    onInspect: (tool: ChatToolRow) => void;
    onOpen: (target: ChatTarget) => void;
    attachmentUrl: (id: string) => string;
    assistantFallback: (run: ChatRun) => string;
    onReload: () => void;
    onResolve: (confirmed: boolean, run: ChatRun) => void;
    agentMessages?: AgentMessageVM[];
    document?: DocumentVM | null;
    onSetAgentMessageStatus?: (id: string, status: AgentMessageVM['status']) => void;
    onRecordDecision?: RecordAgentMessageDecision;
  } = $props();

  const allRows = $derived(scopedMessageRows(runs, agentMessages, context, document));
  const recentRows = $derived(allRows.slice(-5));
  const attention = $derived(messagesForContext(agentMessages, context, document).filter(messageNeedsAttention));
  const pendingRuns = $derived(allRows.flatMap((row) =>
    row.kind === 'run' && row.run.status === 'awaiting_confirmation' ? [row.run] : []));
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
    {#if loading}<p role="status">Loading messages…</p>{/if}
    {#if error}<div class="history-error" role="alert">{error} <button onclick={onReload}>Retry loading messages</button></div>{/if}
    {#if pendingRuns.length}
      <section aria-label="Tool action confirmation needed">
        <strong>Tool action confirmation needed</strong>
        {#each pendingRuns as run (run.journalId ?? run.key)}
          <div class="pending-run-review">
            <span>{run.userText}</span>
            <button onclick={() => (expanded = true)}>Expand confirmation</button>
            <button onclick={() => onFocus(run)}>Review in Log</button>
          </div>
        {/each}
      </section>
    {/if}
    {#if attention.length}
      <section class="message-attention" aria-label="Needs your attention">
        <strong>Needs your attention ({attention.length})</strong>
        {#each attention as message (message.id)}
          <AgentMessageCard {message} onSetStatus={onSetAgentMessageStatus} {onRecordDecision} />
        {/each}
      </section>
    {/if}
    <div id="scoped-messages" class:scope-preview-history={expanded}>
      {#if allRows.length === 0 && !loading && !error}
        <p>No messages for this scope.</p>
      {:else if !expanded}
        {#each recentRows as row, index (row.key)}
          <div class="scope-preview-row" class:latest={index === recentRows.length - 1} data-journal-id={row.kind === 'run' ? row.run.journalId : undefined} data-agent-message-id={row.kind === 'agent-message' ? row.message.id : undefined}>
            <button class="scope-preview-main" onclick={() => (expanded = true)} title="Expand for all messages and details">
              <span class="scope-preview-text">{row.kind === 'run' ? row.run.assistantText || row.run.userText : `${row.message.title}: ${row.message.description}`}</span>
            </button>
            <span class="timeline-state">{(row.kind === 'run' ? row.run.status : row.message.status).replaceAll('_', ' ')}</span>
          </div>
        {/each}
      {:else}
        {#each allRows as row (row.key)}
          {#if row.kind === 'agent-message'}
            <AgentMessageCard message={row.message} onSetStatus={onSetAgentMessageStatus} {onRecordDecision} />
          {:else}
          {@const run = row.run}
          <article class="scope-preview-response" data-journal-id={run.journalId}>
            <header class="timeline-command">
              <span class="timeline-dot" aria-hidden="true"></span>
              <time datetime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleString()}</time>
              <span class="timeline-state">{run.status.replaceAll('_', ' ')}</span>
              <button onclick={() => onFocus(run)} title="Show in history">Show in Log</button>
            </header>
            <section class="scope-preview-human">
              <span aria-hidden="true">{humanInitials(humanName)}</span>
              <div>
                {#if run.attachments.length}
                  <div class="user-attachments" aria-label="Attached images">
                    {#each run.attachments as attachment (attachment.id)}
                      <img src={attachmentUrl(attachment.id)} alt={attachment.filename} title={attachment.filename} />
                    {/each}
                  </div>
                {/if}
                <div class="user-markdown">{@html renderMarkdown(run.userText)}</div>
              </div>
            </section>
            <ToolActivity {run} {onInspect} {onOpen} />
            <section class="scope-preview-assistant" class:partial={!run.assistantText}
              use:observeResponse={{ key: responseKey(run), enabled: unreadResponses.some((record) => record.key === responseKey(run)), onViewed }}>
              <span>WM</span>
              {#if run.assistantText}
                <div class="assistant-markdown">{@html renderMarkdown(run.assistantText)}</div>
              {:else}
                <p>{assistantFallback(run)}</p>
              {/if}
            </section>
            {#if isRetryableRun(run)}
              <button class="retry-button" disabled={runBlocked(run)} onclick={() => onRetry(run)}>Retry</button>
            {/if}
            {#if run.status === 'awaiting_confirmation'}
              <section class="confirmation" aria-label="Tool action confirmation">
                {#if run.pendingConfirmation}
                  {@const pending = run.pendingConfirmation}
                  <strong>{pending.batchCount ? `Confirm ${pending.batchCount} changes?` : `Confirm ${pending.tool}?`}</strong>
                  {#if pending.batchCount}
                    <ul>
                      {#each pending.batchActions ?? [] as action}
                        <li><strong>{action.summary}</strong> <code>{action.tool}</code></li>
                      {/each}
                    </ul>
                  {:else}
                    <pre>{JSON.stringify(pending.arguments, null, 2)}</pre>
                  {/if}
                  <button class="confirm" onclick={() => onResolve(true, run)}>Confirm</button>
                  <button class="cancel" onclick={() => onResolve(false, run)}>Cancel</button>
                {:else}
                  <p>Awaiting confirmation. Open the Log to review this request.</p>
                  <button onclick={() => onFocus(run)}>Review in Log</button>
                {/if}
              </section>
            {/if}
          </article>
          {/if}
        {/each}
      {/if}
    </div>
  {/if}
</section>
