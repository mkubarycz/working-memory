<script lang="ts">
  import { onMount, tick } from 'svelte';
  import MarkdownIt from 'markdown-it';
  import { createVsCodeTransport } from './transport';
  import { scopeKeyFor, isCurrentScope } from './scope';

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
    /**
     * The underlying CommandJournal doc id for this turn (both the user and
     * assistant entry of a turn share it). Set from `hydrate` on replay, or from
     * `attachJournalId` once a live run's record is persisted. When set, the
     * entry is right-click-openable.
     */
    journalId?: string;
  }

  let command = $state('');
  let contextSlug = $state<string | null>(null);
  let contextKind = $state<string | null>(null);
  let running = $state(false);
  let messages = $state<ChatEntry[]>([]);

  // Tiny custom context menu shown on right-click of a journalled entry.
  let menu = $state<{ x: number; y: number; id: string } | null>(null);

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

  /**
   * Tag the trailing turn (last assistant entry + the user entry immediately
   * before it) with the journal id from a completed live run, making the live
   * bubble clickable without a reload.
   */
  function attachJournalId(id: string): void {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'assistant') {
        messages[i] = { ...messages[i], journalId: id };
        if (i > 0 && messages[i - 1].role === 'user') {
          messages[i - 1] = { ...messages[i - 1], journalId: id };
        }
        messages = messages;
        return;
      }
    }
  }

  /** Right-click a journalled entry: show a one-item "open record" menu. */
  function onEntryContextMenu(event: MouseEvent, entry: ChatEntry): void {
    if (!entry.journalId) {
      return;
    }
    event.preventDefault();
    menu = { x: event.clientX, y: event.clientY, id: entry.journalId };
  }

  /** Open the record for the menu's entry and dismiss the menu. */
  function openJournalRecord(): void {
    if (menu) {
      transport.post({ type: 'openJournal', id: menu.id });
      menu = null;
    }
  }

  onMount(() => {
    const unsubscribe = transport.subscribe((msg) => {
      if (msg.type === 'context') {
        contextSlug = msg.slug;
        contextKind = msg.kind;
      } else if (msg.type === 'briefRunning') {
        // The host confirms the loop started; the pending assistant entry is
        // already showing the running indicator, so this is a no-op reaffirm —
        // but only for the scope on screen (ignore a run from a scope the user
        // has since switched away from).
        if (isCurrentScope(msg.scope, scopeKeyFor(contextSlug))) {
          running = true;
        }
      } else if (msg.type === 'brief') {
        // Only fold a finished brief into the transcript when its run's scope is
        // still the one displayed; otherwise the record is already persisted and
        // will replay on next hydrate of that scope (mid-run scope-switch guard).
        if (isCurrentScope(msg.scope, scopeKeyFor(contextSlug))) {
          running = false;
          resolvePending({ html: md.render(msg.markdown), state: 'done' });
        }
      } else if (msg.type === 'briefError') {
        if (isCurrentScope(msg.scope, scopeKeyFor(contextSlug))) {
          running = false;
          resolvePending({ text: msg.message, state: 'error' });
        }
      } else if (msg.type === 'hydrate') {
        // Replay replaces the in-memory transcript so switching scope shows that
        // scope's chat and a reload restores it. Briefs render via markdown-it
        // (html:false) exactly like a live brief. Both entries of a turn carry
        // the journal id so either can be right-clicked to open the record.
        running = false;
        menu = null;
        messages = msg.turns.flatMap((turn): ChatEntry[] => [
          { role: 'user', text: turn.command, html: '', state: 'done', journalId: turn.id },
          {
            role: 'assistant',
            text: '',
            html: md.render(turn.brief),
            state: 'done',
            journalId: turn.id,
          },
        ]);
      } else if (msg.type === 'attachJournalId') {
        // Tag the just-created live turn (its trailing user+assistant pair)
        // with the journal id so it's immediately openable — but only when the
        // run's scope is still on screen (a scope-switch replaced the transcript
        // via hydrate, so there's no live turn here to tag).
        if (isCurrentScope(msg.scope, scopeKeyFor(contextSlug))) {
          attachJournalId(msg.id);
        }
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

  // Enter submits; Shift+Enter inserts a newline (multi-line commands).
  // Cmd/Ctrl+Enter is kept as an alias that also submits.
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
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
    {:else}
      <!-- margin-top:auto anchors a short history to the bottom (chat style);
           when it overflows the auto margin collapses and the transcript scrolls. -->
      <div class="messages">
        {#each messages as entry, i (i)}
          {#if entry.role === 'user'}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="entry user"
              class:journalled={entry.journalId}
              title={entry.journalId ? 'Right-click to open its CommandJournal record' : undefined}
              oncontextmenu={(e) => onEntryContextMenu(e, entry)}
            >
              <div class="bubble">{entry.text}</div>
            </div>
          {:else}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="entry assistant"
              class:journalled={entry.journalId}
              title={entry.journalId ? 'Right-click to open its CommandJournal record' : undefined}
              oncontextmenu={(e) => onEntryContextMenu(e, entry)}
            >
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
    {/if}
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
      <span class="hint">Enter to send, Shift+Enter for newline</span>
      <button type="button" onclick={submit} disabled={running || command.trim().length === 0}>
        {running ? 'Working…' : 'Run command'}
      </button>
    </div>
  </div>

  {#if menu}
    <!-- One-item context menu; a full-screen backdrop dismisses it on any click. -->
    <div
      class="menu-backdrop"
      role="presentation"
      onclick={() => (menu = null)}
      oncontextmenu={(e) => {
        e.preventDefault();
        menu = null;
      }}
    ></div>
    <div class="context-menu" style="left: {menu.x}px; top: {menu.y}px;">
      <button type="button" onclick={openJournalRecord}>
        <span class="codicon codicon-go-to-file" aria-hidden="true"></span>
        Open CommandJournal record
      </button>
    </div>
  {/if}
</main>

<style>
  /* Size the webview to its CONTAINER, not the viewport. In a WebviewView the
     viewport isn't the whole editor, so `100vh` overflows and phantom-scrolls.
     Scoped via :global here (only the command webview mounts CommandWidget, so
     the shared document editor's #app padding/max-width is untouched). */
  :global(html),
  :global(body),
  :global(#app) {
    height: 100%;
    margin: 0;
  }
  :global(#app) {
    padding: 0;
    max-width: none;
  }

  main {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    box-sizing: border-box;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
  }

  /* Only the transcript scrolls; composer stays pinned. min-height:0 lets the
     flex child shrink so overflow-y actually engages. */
  .transcript {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
    padding: 10px;
    display: flex;
    flex-direction: column;
  }

  /* Newest at the bottom: auto top-margin rests a short history against the
     composer and collapses once the list overflows into scroll. */
  .messages {
    margin-top: auto;
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

  /* Full-screen transparent catcher that dismisses the menu on any click. */
  .menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 10;
  }

  .context-menu {
    position: fixed;
    z-index: 11;
    background: var(--vscode-menu-background, var(--vscode-editor-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, transparent));
    border-radius: 5px;
    box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
    padding: 4px;
    min-width: 200px;
  }
  .context-menu button {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    border: none;
    background: transparent;
    color: inherit;
    text-align: left;
    padding: 4px 8px;
    border-radius: 4px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    cursor: pointer;
  }
  .context-menu button:hover {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
  }

  .composer {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 8px 10px;
    box-sizing: border-box;
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
