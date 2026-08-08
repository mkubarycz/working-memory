<script lang="ts">
  import { onMount, tick } from 'svelte';
  import MarkdownIt from 'markdown-it';
  import { createVsCodeTransport } from './transport';

  // markdown-it with `html:false` — raw HTML in the brief is escaped, so the
  // `{@html}` below only ever renders markdown-it's own sanitized output. This
  // is the required pattern: never `{@html}` untrusted text directly.
  const md = new MarkdownIt({ html: false, linkify: true, breaks: true });

  const transport = createVsCodeTransport();

  /**
   * One entry in the in-memory chat transcript (POC — not persisted across
   * reload). A `user` entry is the raw command; an `assistant` entry is the
   * running indicator, then the rendered brief (or an error) once the host
   * finishes the tool-calling loop. Only one command runs at a time, so the
   * newest `running` assistant entry is always the one to fill in.
   */
  interface ChatEntry {
    role: 'user' | 'assistant';
    /** Raw text (user command, or assistant error message). */
    text: string;
    /** Rendered markdown brief (assistant `done` only). */
    html: string;
    state: 'running' | 'done' | 'error';
  }

  let command = $state('');
  let contextSlug = $state<string | null>(null);
  let contextKind = $state<string | null>(null);
  let running = $state(false);
  let messages = $state<ChatEntry[]>([]);

  let transcriptEl: HTMLDivElement | undefined = $state();

  // Auto-scroll to the newest entry whenever the transcript changes.
  $effect(() => {
    // Touch the reactive deps so the effect re-runs on every append/update.
    void messages.length;
    void messages.at(-1)?.state;
    if (transcriptEl) {
      void tick().then(() => {
        transcriptEl?.scrollTo({ top: transcriptEl.scrollHeight });
      });
    }
  });

  /** Replace the newest pending assistant entry (the one that's `running`). */
  function resolvePending(patch: Partial<ChatEntry>): void {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant' && messages[i].state === 'running') {
        messages[i] = { ...messages[i], ...patch };
        messages = messages;
        return;
      }
    }
  }

  onMount(() => {
    const unsubscribe = transport.subscribe((msg) => {
      if (msg.type === 'context') {
        contextSlug = msg.slug;
        contextKind = msg.kind;
      } else if (msg.type === 'briefRunning') {
        // The host confirms the loop started; the pending assistant entry is
        // already showing the running indicator, so this is a no-op reaffirm.
        running = true;
      } else if (msg.type === 'brief') {
        running = false;
        resolvePending({ html: md.render(msg.markdown), state: 'done' });
      } else if (msg.type === 'briefError') {
        running = false;
        resolvePending({ text: msg.message, state: 'error' });
      }
    });
    transport.post({ type: 'ready' });
    return unsubscribe;
  });

  function submit(): void {
    const trimmed = command.trim();
    if (trimmed.length === 0 || running) {
      return;
    }
    running = true;
    messages = [
      ...messages,
      { role: 'user', text: trimmed, html: '', state: 'done' },
      { role: 'assistant', text: '', html: '', state: 'running' },
    ];
    command = '';
    transport.post({ type: 'submitCommand', command: trimmed, contextSlug });
  }

  // Cmd/Ctrl+Enter submits; plain Enter inserts a newline (multi-line commands).
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    }
  }
</script>

<main>
  <div class="transcript" bind:this={transcriptEl}>
    {#if messages.length === 0}
      <div class="empty">
        Tell Working Memory what to do. Commands stack here as a running
        back-and-forth.
      </div>
    {/if}
    {#each messages as entry, i (i)}
      {#if entry.role === 'user'}
        <div class="entry user">
          <div class="bubble">{entry.text}</div>
        </div>
      {:else}
        <div class="entry assistant">
          {#if entry.state === 'running'}
            <div class="bubble running">
              <span class="spinner codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></span>
              Running the local model tool-calling loop…
            </div>
          {:else if entry.state === 'error'}
            <div class="bubble error">{entry.text}</div>
          {:else}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="bubble brief-body">{@html entry.html}</div>
          {/if}
        </div>
      {/if}
    {/each}
  </div>

  <div class="composer">
    <div class="context">
      {#if contextSlug}
        <span class="codicon codicon-target" aria-hidden="true"></span>
        <span class="context-label">Scope:</span>
        <code>{contextSlug}</code>
        {#if contextKind}<span class="context-kind">({contextKind})</span>{/if}
      {:else}
        <span class="context-none">No Working Memory document selected</span>
      {/if}
    </div>

    <textarea
      class="command"
      bind:value={command}
      onkeydown={onKeydown}
      placeholder="Tell Working Memory what to do — e.g. “create a bug topic about the flaky reload and add it to this workstream”."
      rows="3"
      disabled={running}
    ></textarea>

    <div class="actions">
      <span class="hint">⌘/Ctrl + Enter</span>
      <button type="button" onclick={submit} disabled={running || command.trim().length === 0}>
        {running ? 'Working…' : 'Run command'}
      </button>
    </div>
  </div>
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    height: 100vh;
    box-sizing: border-box;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }

  /* Transcript scrolls; composer is pinned to the bottom. */
  .transcript {
    flex: 1;
    overflow-y: auto;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    margin: auto 0;
    text-align: center;
    padding: 0 12px;
  }

  .entry {
    display: flex;
  }
  .entry.user {
    justify-content: flex-end;
  }
  .entry.assistant {
    justify-content: flex-start;
  }

  .bubble {
    max-width: 92%;
    border-radius: 8px;
    padding: 6px 10px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .entry.user .bubble {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-bottom-right-radius: 2px;
  }
  .entry.assistant .bubble {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
    border-bottom-left-radius: 2px;
    white-space: normal;
  }

  .bubble.running {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .bubble.error {
    background: var(--vscode-inputValidation-errorBackground);
    border-color: var(--vscode-inputValidation-errorBorder);
    color: var(--vscode-foreground);
    white-space: pre-wrap;
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    border-top: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
  }

  .context {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.9em;
    color: var(--vscode-descriptionForeground);
    min-height: 18px;
  }
  .context code {
    color: var(--vscode-textPreformat-foreground);
  }
  .context-kind {
    opacity: 0.7;
  }
  .context-none {
    font-style: italic;
  }

  textarea.command {
    width: 100%;
    box-sizing: border-box;
    resize: vertical;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 6px 8px;
  }
  textarea.command:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 10px;
  }
  .hint {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  button {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    padding: 4px 12px;
    border-radius: 2px;
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .brief-body :global(p) {
    margin: 0.4em 0;
  }
  .brief-body :global(p:first-child) {
    margin-top: 0;
  }
  .brief-body :global(p:last-child) {
    margin-bottom: 0;
  }
  .brief-body :global(ul) {
    margin: 0.4em 0;
    padding-left: 1.2em;
  }
  .brief-body :global(code) {
    color: var(--vscode-textPreformat-foreground);
  }
  .brief-body :global(blockquote) {
    margin: 0.4em 0;
    padding-left: 0.8em;
    border-left: 3px solid var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder));
    color: var(--vscode-descriptionForeground);
  }
</style>
