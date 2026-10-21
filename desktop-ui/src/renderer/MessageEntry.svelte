<script module lang="ts">
  import type { MessageRow } from './agentMessages';
  import type { ChatRun, ChatTarget, ChatToolRow } from './chatHistory';
  import type { AgentMessageVM, DocumentVM, RecordAgentMessageDecision } from './documents/types';
  import type { UnreadResponse } from './chatUnread';

  export interface MessageEntryProps {
    row: MessageRow;
    expanded?: boolean;
    latest?: boolean;
    showScope?: boolean;
    showInLog?: boolean;
    attachRunIds?: boolean;
    humanName: string;
    documents?: DocumentVM[];
    unreadResponses: UnreadResponse[];
    onViewed: (key: string) => void;
    onFocus: (run: ChatRun) => void;
    onRetry: (run: ChatRun) => void;
    runBlocked: (run: ChatRun) => boolean;
    onInspect: (tool: ChatToolRow) => void;
    onOpen: (target: ChatTarget) => void;
    attachmentUrl: (id: string) => string;
    attachmentBaseUrl?: string;
    assistantFallback: (run: ChatRun) => string;
    onResolve: (confirmed: boolean, run: ChatRun) => void;
    onSetAgentMessageStatus: (id: string, status: AgentMessageVM['status']) => void;
    onRecordDecision?: RecordAgentMessageDecision;
  }
</script>

<script lang="ts">
  import { isRetryableRun, targetForRef } from './chatHistory';
  import { messageNeedsAttention } from './agentMessages';
  import { chatRunDomId } from './scopedChat';
  import { observeResponse, responseKey } from './chatUnread';
  import { renderMarkdown } from './markdown';
  import { humanInitials } from './humanIdentity';
  import { documentTabIcon } from './documentTabs';
  import { normalizeScopeKind } from './scopeIdentity';
  import AgentMessageCard from './documents/AgentMessageCard.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import UnreadBadge from './UnreadBadge.svelte';

  let {
    row, expanded = $bindable(true), latest = false, showScope = true, showInLog = false,
    attachRunIds = false, humanName, documents = [], unreadResponses, onViewed, onFocus, onRetry, runBlocked,
    onInspect, onOpen, attachmentUrl, attachmentBaseUrl = '', assistantFallback, onResolve,
    onSetAgentMessageStatus, onRecordDecision,
  }: MessageEntryProps = $props();

  const run = $derived(row.kind === 'run' ? row.run : undefined);
  const message = $derived(row.kind === 'agent-message' ? row.message : undefined);
  const scopeTarget = $derived(run ? targetForRef(run.scope) : undefined);
  const scopeDocument = $derived(run ? documents.find((document) =>
    normalizeScopeKind(document.kind) === normalizeScopeKind(run.scope.kind)
    && (document.slug != null && (document.slug === run.scope.slug || document.slug === run.scope.id)
      || 'id' in document && document.id === run.scope.id)) : undefined);
  const scopeIcon = $derived(scopeDocument ? documentTabIcon(scopeDocument)
    : scopeTarget?.kind === 'topic' ? 'symbol-misc' : scopeTarget?.kind === 'workstream' ? 'briefcase' : 'link');
  const status = $derived(run?.status ?? message?.status ?? '');
  const attention = $derived(message ? messageNeedsAttention(message) : false);
  const preview = $derived(run
    ? (run.status === 'awaiting_confirmation' ? run.userText : run.assistantText || run.userText) || assistantFallback(run)
    : `${message?.title}: ${message?.description}`);
</script>

<details
  class="chat-run message-entry"
  class:latest
  class:needs-attention={attention}
  bind:open={expanded}
  id={attachRunIds && run ? chatRunDomId(run) : undefined}
  data-journal-id={run?.journalId}
  data-agent-message-id={message?.id}
  tabindex="-1"
>
  <summary class="timeline-command">
    <span class="timeline-dot" aria-hidden="true"></span>
    {#if expanded}
      <time datetime={new Date(row.timestamp).toISOString()}>{new Date(row.timestamp).toLocaleString()}</time>
    {:else}
      <span class="message-preview">{preview}</span>
    {/if}
    {#if attention}<span class="attention-label">Needs your attention</span>{/if}
    <span class="timeline-state">{status.replaceAll('_', ' ')}</span>
    {#if run}
      <UnreadBadge count={unreadResponses.some((record) => record.key === responseKey(run)) ? 1 : 0} />
    {/if}
  </summary>
  {#if expanded}
    <div class="timeline-details">
      {#if message}
        <section class="assistant-entry agent-message-entry">
          <span class="message-avatar assistant-avatar" title={message.agentName} aria-hidden="true">{humanInitials(message.agentName)}</span>
          <div class="message-content">
            <div class="message-from">{message.agentName}</div>
            <AgentMessageCard {message} embedded onSetStatus={onSetAgentMessageStatus} {onRecordDecision} {attachmentBaseUrl} />
          </div>
        </section>
      {:else if run}
        {#if showInLog}
          <button class="show-in-log" onclick={() => onFocus(run)}>Show in Log</button>
        {/if}
        {#if showScope}
          {#if scopeTarget}
            <button class="user-scope" onclick={() => onOpen(scopeTarget)}>
              <span aria-hidden="true" class="codicon codicon-{scopeIcon}"></span>
              <span>{run.scope.title ?? run.scope.slug ?? run.scope.id}</span>
            </button>
          {:else}
            <span class="user-scope unsupported">{run.scope.title ?? run.scope.slug ?? run.scope.id}</span>
          {/if}
        {/if}
        <section class="user-entry">
          <span class="message-avatar human-avatar" title={humanName} aria-hidden="true">{humanInitials(humanName)}</span>
          <div class="message-content">
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
        <section class="assistant-entry" class:partial={!run.assistantText}
          use:observeResponse={{ key: responseKey(run), enabled: unreadResponses.some((record) => record.key === responseKey(run)), onViewed }}>
          <span class="message-avatar assistant-avatar" title="Working Memory" aria-hidden="true">WM</span>
          <div class="message-content">
            {#if run.assistantText}
              <div class="assistant-markdown">{@html renderMarkdown(run.assistantText)}</div>
            {:else}
              <p>{assistantFallback(run)}</p>
            {/if}
          </div>
        </section>
        {#if isRetryableRun(run)}
          <div class="run-actions">
            <button class="retry-button" disabled={runBlocked(run)} onclick={() => onRetry(run)}>Retry</button>
          </div>
        {/if}
        {#if run.status === 'awaiting_confirmation'}
          <section class="confirmation" aria-label="Tool action confirmation">
            {#if run.pendingConfirmation}
              {@const pendingConfirmation = run.pendingConfirmation}
              <strong>{pendingConfirmation.batchCount ? `Confirm ${pendingConfirmation.batchCount} changes?` : `Confirm ${pendingConfirmation.tool}?`}</strong>
              {#if pendingConfirmation.batchCount}
                <p>One approval covers this bounded batch. Calls and results will remain individually visible.</p>
                <ul>
                  {#each pendingConfirmation.batchActions ?? [] as action}
                    <li><strong>{action.summary}</strong> <code>{action.tool}</code></li>
                  {/each}
                </ul>
              {:else}
                <pre>{JSON.stringify(pendingConfirmation.arguments, null, 2)}</pre>
              {/if}
              <div>
                <button class="confirm" onclick={() => onResolve(true, run)}>Confirm</button>
                <button class="cancel" onclick={() => onResolve(false, run)}>Cancel</button>
              </div>
            {:else}
              <p>Awaiting confirmation. Open the Log to review this request.</p>
              <button onclick={() => onFocus(run)}>Review in Log</button>
            {/if}
          </section>
        {/if}
      {/if}
    </div>
  {/if}
</details>
