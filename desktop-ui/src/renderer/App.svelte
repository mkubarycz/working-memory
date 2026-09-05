<script lang="ts">
  import { onMount } from 'svelte';
  import ActiveRail from './ActiveRail.svelte';
  import WorkstreamView from '../../../webview-ui/src/lib/WorkstreamView.svelte';
  import TopicView from '../../../webview-ui/src/lib/TopicView.svelte';
  import DocumentView from '../../../webview-ui/src/lib/DocumentView.svelte';
  import type { AlertVM, DocumentVM, SaveState, TopicPatch } from '../../../webview-ui/src/lib/types';
  import { chatContextForDocument } from '../shared/contracts';
  import type { ChatResult, DesktopResourceKind, PendingConfirmation, PublicConfig, ToolProgress } from '../shared/contracts';
  import type { PanelAction, PanelData } from '../../../src/panelData';
  import { invokeActiveAction } from './activeContextMenu';
  import { RAIL_LAYOUT, parseStoredRailWidth, resizeRail, resolveRailWidths } from './railLayout';
  import type { RailSide, RailWidths } from './railLayout';

  type Page = 'workspace' | 'settings';
  type Turn = { role: 'user' | 'assistant'; text: string; progress?: ToolProgress[] };

  let page = $state<Page>('workspace');
  let input = $state('Show me the 0.15.0 roadmap workstream');
  let turns = $state<Turn[]>([
    { role: 'assistant', text: 'Ask me to open a Working Memory workstream.' },
  ]);
  let documents = $state<DocumentVM[]>([]);
  let saveState = $state<SaveState>('idle');
  let documentError = $state('');
  let saveTimer: number | undefined;
  let busy = $state(false);
  let endpoint = $state('');
  let model = $state('');
  let apiKey = $state('');
  let hasApiKey = $state(false);
  let settingsStatus = $state('');
  let saving = $state(false);
  let testing = $state(false);
  let pendingConfirmation = $state<PendingConfirmation | null>(null);
  let activePanel = $state<PanelData | null>(null);
  let activeLoading = $state(false);
  let activeError = $state('');
  let activeRailCollapsed = $state(false);
  let chatRailCollapsed = $state(false);
  let activeRailWidth = $state(RAIL_LAYOUT.active.default);
  let chatRailWidth = $state(RAIL_LAYOUT.chat.default);
  let viewportWidth = $state(1280);
  let railDrag: { side: RailSide; startX: number; widths: RailWidths } | null = null;
  const activeDocument = $derived(documents.at(-1) ?? null);
  const currentChatContext = $derived(chatContextForDocument(activeDocument));
  const resolvedRailWidths = $derived(resolveRailWidths(
    { active: activeRailWidth, chat: chatRailWidth },
    viewportWidth,
    { active: activeRailCollapsed, chat: chatRailCollapsed },
  ));

  const RAIL_STORAGE_KEYS = {
    active: 'working-memory.desktop.active-rail-width',
    chat: 'working-memory.desktop.chat-rail-width',
  } as const;

  function applyChatResult(result: ChatResult): void {
    turns = [...turns, { role: 'assistant', text: result.message, progress: result.progress }];
    pendingConfirmation = result.pendingConfirmation ?? null;
    const document = result.document ?? result.workstream;
    if (document) {
      documents = [document];
      documentError = '';
    }
    void refreshActive();
  }

  onMount(() => {
    activeRailWidth = parseStoredRailWidth(localStorage.getItem(RAIL_STORAGE_KEYS.active), 'active');
    chatRailWidth = parseStoredRailWidth(localStorage.getItem(RAIL_STORAGE_KEYS.chat), 'chat');
    viewportWidth = window.innerWidth;
    const handleResize = () => { viewportWidth = window.innerWidth; };
    window.addEventListener('resize', handleResize);
    void window.workingMemory.getConfig().then(loadConfig);
    void refreshActive();
    return () => {
      window.removeEventListener('resize', handleResize);
      document.body.classList.remove('resizing-rails');
    };
  });

  function preferredRailWidths(): RailWidths {
    return { active: activeRailWidth, chat: chatRailWidth };
  }

  function setRailWidth(side: RailSide, width: number, persist = false): void {
    if (side === 'active') activeRailWidth = width;
    else chatRailWidth = width;
    if (persist) localStorage.setItem(RAIL_STORAGE_KEYS[side], String(Math.round(width)));
  }

  function startRailResize(side: RailSide, event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    railDrag = { side, startX: event.clientX, widths: preferredRailWidths() };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-rails');
  }

  function moveRailResize(event: PointerEvent): void {
    if (!railDrag) return;
    setRailWidth(railDrag.side, resizeRail(
      railDrag.side,
      event.clientX - railDrag.startX,
      railDrag.widths,
      viewportWidth,
      { active: activeRailCollapsed, chat: chatRailCollapsed },
    ));
  }

  function finishRailResize(): void {
    if (!railDrag) return;
    setRailWidth(railDrag.side, resolvedRailWidths[railDrag.side], true);
    railDrag = null;
    document.body.classList.remove('resizing-rails');
  }

  function resizeRailWithKeyboard(side: RailSide, event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const step = event.altKey ? 1 : event.shiftKey ? 32 : 8;
    const pointerDelta = event.key === 'Home'
      ? (side === 'active' ? -10_000 : 10_000)
      : event.key === 'End'
        ? (side === 'active' ? 10_000 : -10_000)
        : event.key === 'ArrowRight' ? step : -step;
    setRailWidth(side, resizeRail(
      side,
      pointerDelta,
      preferredRailWidths(),
      viewportWidth,
      { active: activeRailCollapsed, chat: chatRailCollapsed },
    ), true);
  }

  async function refreshActive(): Promise<void> {
    if (activeLoading) return;
    activeLoading = true;
    activeError = '';
    try {
      activePanel = await window.workingMemory.getActivePanel();
      if (activePanel.items.length === 0 && activePanel.emptyMessage !== 'No active workstreams.') {
        activeError = activePanel.emptyMessage;
      }
    } catch (error) {
      activeError = error instanceof Error ? error.message : String(error);
    } finally {
      activeLoading = false;
    }
  }

  function loadConfig(config: PublicConfig): void {
    endpoint = config.endpoint;
    model = config.model;
    hasApiKey = config.hasApiKey;
    apiKey = '';
  }

  async function send(): Promise<void> {
    const message = input.trim();
    if (!message || busy || pendingConfirmation) return;
    turns = [...turns, { role: 'user', text: message }];
    input = '';
    busy = true;
    try {
      applyChatResult(await window.workingMemory.sendChat(message, currentChatContext));
    } catch (error) {
      turns = [...turns, {
        role: 'assistant',
        text: `Unable to complete that request: ${error instanceof Error ? error.message : String(error)}`,
      }];
    } finally {
      busy = false;
    }
  }

  async function resolveConfirmation(confirmed: boolean): Promise<void> {
    const pending = pendingConfirmation;
    if (!pending || busy) return;
    busy = true;
    pendingConfirmation = null;
    try {
      applyChatResult(await window.workingMemory.resolveChatConfirmation(pending.id, confirmed, currentChatContext));
    } catch (error) {
      turns = [...turns, { role: 'assistant', text: `Unable to resolve that action: ${error instanceof Error ? error.message : String(error)}` }];
    } finally {
      busy = false;
    }
  }

  async function saveSettings(): Promise<void> {
    if (saving || testing) return;
    saving = true;
    settingsStatus = 'Saving…';
    try {
      loadConfig(await window.workingMemory.saveConfig({ endpoint, model, apiKey }));
      settingsStatus = 'Saved';
    } catch (error) {
      settingsStatus = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
    }
  }

  async function testConnection(): Promise<void> {
    if (saving || testing) return;
    testing = true;
    settingsStatus = 'Testing…';
    try {
      const submittedApiKey = Boolean(apiKey.trim());
      const result = await window.workingMemory.testConnection({ endpoint, model, apiKey });
      if (result.ok) {
        apiKey = '';
        hasApiKey = hasApiKey || submittedApiKey;
      }
      settingsStatus = result.message;
    } catch (error) {
      settingsStatus = error instanceof Error ? error.message : String(error);
    } finally {
      testing = false;
    }
  }

  function replaceActive(document: DocumentVM): void {
    documents = [...documents.slice(0, -1), document];
  }

  async function openResource(kind: DesktopResourceKind, identifier: string): Promise<void> {
    try {
      const document = await window.workingMemory.openResource(kind, identifier);
      documents = [...documents, document];
      documentError = '';
      saveState = 'idle';
    } catch (error) {
      documentError = error instanceof Error ? error.message : String(error);
    }
  }

  async function mutate(operation: () => Promise<DocumentVM>): Promise<void> {
    saveState = 'saving';
    documentError = '';
    try {
      replaceActive(await operation());
      saveState = 'saved';
    } catch (error) {
      saveState = 'error';
      documentError = error instanceof Error ? error.message : String(error);
    } finally {
      void refreshActive();
    }
  }

  async function mutateFromRail(workstream: string, operation: () => Promise<DocumentVM>): Promise<void> {
    let mutationError = '';
    try {
      const document = await operation();
      if (activeDocument?.kind === 'workstream' && activeDocument.slug === workstream) replaceActive(document);
      documentError = '';
    } catch (error) {
      mutationError = error instanceof Error ? error.message : String(error);
      documentError = mutationError;
    } finally {
      await refreshActive();
      if (mutationError) activeError = mutationError;
    }
  }

  function runActiveAction(workstream: string, action: PanelAction): void {
    if (!workstream || action.enabled === false) return;
    void mutateFromRail(workstream, () => invokeActiveAction(window.workingMemory.invokeAction, workstream, action));
  }

  function toggleActiveFocus(workstream: string, topic: string): void {
    if (!workstream || !topic) return;
    void mutateFromRail(workstream, () => window.workingMemory.togglePin(workstream, topic));
  }

  function scheduleSave(operation: () => Promise<DocumentVM>): void {
    saveState = 'pending';
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void mutate(operation), 350);
  }

  function saveWorkstream(patch: { title?: string; status?: string }): void {
    const document = activeDocument;
    if (document?.kind !== 'workstream' || !document.slug) return;
    const identifier = document.slug;
    scheduleSave(() => window.workingMemory.saveWorkstream(identifier, patch));
  }

  function saveTopic(patch: TopicPatch): void {
    const document = activeDocument;
    if (document?.kind !== 'topic' || !document.slug) return;
    const identifier = document.slug;
    scheduleSave(() => window.workingMemory.saveTopic(identifier, patch));
  }

  function setAlertStatus(id: string, status: AlertVM['status']): void {
    const document = activeDocument;
    if (!document || (document.kind !== 'workstream' && document.kind !== 'topic')) return;
    const identifier = document.slug ?? '';
    void mutate(() => window.workingMemory.setAlertStatus({ kind: document.kind, identifier }, id, status));
  }

  function togglePin(topic: string): void {
    const document = activeDocument;
    if (document?.kind !== 'workstream' || !document.slug) return;
    void mutate(() => window.workingMemory.togglePin(document.slug!, topic));
  }

  function invokeAction(command: string, args: unknown[]): void {
    const document = activeDocument;
    if (document?.kind !== 'workstream' || !document.slug) return;
    void mutate(() => window.workingMemory.invokeAction(document.slug!, command, args));
  }

  function openRoute(route: string): void {
    let match = route.match(/^\/(workstream|topic|document|alert|topic-type)\/([^/]+)\.working-memory$/);
    if (!match) match = route.match(/^working-memory:\/(?:\/)?(workstream|topic|document|alert|topic-type)\/([^/]+)\.working-memory$/);
    if (match) void openResource(match[1] as DesktopResourceKind, decodeURIComponent(match[2]));
  }

  function openLink(rawUrl: string): void {
    try {
      const url = new URL(rawUrl);
      if (url.protocol === 'vscode:' && url.hostname === 'kubarycz.working-memory') {
        const match = url.pathname.match(/^\/open\/(workstream|topic|document|alert|topic-type)\/([^/]+)$/);
        if (match) void openResource(match[1] as DesktopResourceKind, decodeURIComponent(match[2]));
        return;
      }
      if (url.protocol === 'working-memory:') {
        openRoute(url.pathname);
        return;
      }
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        void window.workingMemory.openExternal(url.toString()).catch((error) => {
          documentError = error instanceof Error ? error.message : String(error);
        });
      }
    } catch {
      openRoute(rawUrl);
    }
  }

  function handleDocumentClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(target instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    openLink(target.getAttribute('href') ?? target.href);
  }
</script>

<svelte:window onclick={handleDocumentClick} />

<div
  class="shell"
  class:active-collapsed={activeRailCollapsed}
  class:chat-collapsed={chatRailCollapsed}
  style={`--active-rail-width: ${resolvedRailWidths.active}px; --chat-rail-width: ${resolvedRailWidths.chat}px;`}
>
  <aside class="active-rail">
    {#if activeRailCollapsed}
      <button
        class="rail-reveal active-rail-reveal"
        title="Expand Active rail"
        aria-label={activeRailCollapsed ? 'Expand Active rail' : 'Collapse Active rail'}
        onclick={() => (activeRailCollapsed = false)}
      ><span aria-hidden="true" class="codicon codicon-chevron-right"></span></button>
    {:else}
      <ActiveRail
        data={activePanel}
        loading={activeLoading}
        error={activeError}
        onRefresh={() => void refreshActive()}
        onSettings={() => (page = page === 'settings' ? 'workspace' : 'settings')}
        onCollapse={() => (activeRailCollapsed = true)}
        onOpen={openRoute}
        onToggleFocus={toggleActiveFocus}
        onAction={runActiveAction}
      />
    {/if}
  </aside>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="rail-splitter active-splitter"
    class:splitter-disabled={activeRailCollapsed}
    role="separator"
    aria-label="Resize Active rail"
    aria-orientation="vertical"
    aria-valuemin={RAIL_LAYOUT.active.min}
    aria-valuemax={RAIL_LAYOUT.active.max}
    aria-valuenow={Math.round(resolvedRailWidths.active)}
    aria-hidden={activeRailCollapsed}
    tabindex={activeRailCollapsed ? -1 : 0}
    title="Resize Active rail"
    onpointerdown={(event) => startRailResize('active', event)}
    onpointermove={moveRailResize}
    onpointerup={finishRailResize}
    onpointercancel={finishRailResize}
    onkeydown={(event) => resizeRailWithKeyboard('active', event)}
  ></div>

  <main class="main">
    {#if page === 'settings'}
      <section class="settings">
        <header>
          <p class="eyebrow">Configuration</p>
          <h1>Model connection</h1>
          <p>OpenAI-compatible Chat Completions or Responses endpoint. Credentials stay in OS-backed secure storage.</p>
        </header>
        <label>Endpoint<input bind:value={endpoint} placeholder="http://localhost:11434/v1" /></label>
        <label>Model<input bind:value={model} placeholder="qwen3:14b" /></label>
        <label>API key<input type="password" bind:value={apiKey} placeholder={hasApiKey ? 'Saved securely' : 'Optional for local endpoints'} autocomplete="new-password" /></label>
        <div class="settings-actions">
          <button class="secondary" disabled={saving || testing} onclick={() => void testConnection()}>{testing ? 'Testing…' : 'Test Connection'}</button>
          <button class="primary" disabled={saving || testing} onclick={() => void saveSettings()}>{saving ? 'Saving…' : 'Save'}</button>
          <span>{settingsStatus}</span>
        </div>
      </section>
    {:else if activeDocument}
      <div class="document-host">
        <div class="document-toolbar">
          <button
            class="back-button"
            disabled={documents.length < 2}
            title="Back"
            aria-label="Back"
            onclick={(event) => { event.stopPropagation(); documents = documents.slice(0, -1); documentError = ''; }}
          >←</button>
          {#if documentError}<span class="document-error" role="alert">{documentError}</span>{/if}
        </div>
        {#if activeDocument.kind === 'workstream'}
          <WorkstreamView
            ws={activeDocument}
            {saveState}
            onSave={saveWorkstream}
            onOpenTopic={(slug) => void openResource('topic', slug)}
            onOpenNanite={(id) => void openResource('document', id)}
            onInvoke={invokeAction}
            onTogglePin={togglePin}
            onSetAlertStatus={setAlertStatus}
          />
        {:else if activeDocument.kind === 'topic'}
          <TopicView
            topic={activeDocument}
            {saveState}
            onSaveTopic={saveTopic}
            onOpenTopic={(slug) => void openResource('topic', slug)}
            onOpenWorkstream={(slug) => void openResource('workstream', slug)}
            onSetAlertStatus={setAlertStatus}
          />
        {:else}
          <DocumentView
            doc={activeDocument}
            onOpenDocument={(id) => void openResource('document', id)}
            onOpenRoute={openRoute}
            onOpenExternal={openLink}
          />
        {/if}
      </div>
    {:else}
      <section class="empty-state">
        <p class="eyebrow">Control plane view</p>
        <h1>Choose active work.</h1>
        <p>Open a workstream, topic, or nanite from the Active rail, or ask through chat.</p>
      </section>
    {/if}
  </main>

  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="rail-splitter chat-splitter"
    class:splitter-disabled={chatRailCollapsed}
    role="separator"
    aria-label="Resize Chat rail"
    aria-orientation="vertical"
    aria-valuemin={RAIL_LAYOUT.chat.min}
    aria-valuemax={RAIL_LAYOUT.chat.max}
    aria-valuenow={Math.round(resolvedRailWidths.chat)}
    aria-hidden={chatRailCollapsed}
    tabindex={chatRailCollapsed ? -1 : 0}
    title="Resize Chat rail"
    onpointerdown={(event) => startRailResize('chat', event)}
    onpointermove={moveRailResize}
    onpointerup={finishRailResize}
    onpointercancel={finishRailResize}
    onkeydown={(event) => resizeRailWithKeyboard('chat', event)}
  ></div>

  <aside class="chat-rail">
    {#if chatRailCollapsed}
      <button
        class="rail-reveal chat-rail-reveal"
        title="Expand Chat rail"
        aria-label={chatRailCollapsed ? 'Expand Chat rail' : 'Collapse Chat rail'}
        onclick={() => (chatRailCollapsed = false)}
      ><span aria-hidden="true" class="codicon codicon-chevron-left"></span></button>
    {:else}
      <header class="brand">
        <div class="mark">WM</div>
        <div>
          <strong>Working Memory</strong>
          <span>Desktop</span>
        </div>
        <button
          class="icon-button"
          title="Collapse Chat rail"
          aria-label={chatRailCollapsed ? 'Expand Chat rail' : 'Collapse Chat rail'}
          onclick={() => (chatRailCollapsed = true)}
        ><span aria-hidden="true" class="codicon codicon-chevron-right"></span></button>
      </header>

      <div class="conversation" aria-live="polite">
      {#each turns as turn}
        <div class="turn" class:user={turn.role === 'user'}>
          <span>{turn.role === 'user' ? 'You' : 'WM'}</span>
          <p>{turn.text}</p>
          {#if turn.progress?.length}
            <ul class="tool-progress">
              {#each turn.progress as item}
                <li class:failed={item.status === 'failed'}>{item.name}: {item.summary}</li>
              {/each}
            </ul>
          {/if}
        </div>
      {/each}
      {#if pendingConfirmation}
        <section class="confirmation" aria-label="Destructive action confirmation">
          <strong>Confirm {pendingConfirmation.tool}?</strong>
          <pre>{JSON.stringify(pendingConfirmation.arguments, null, 2)}</pre>
          <div>
            <button class="confirm" disabled={busy} onclick={() => void resolveConfirmation(true)}>Confirm</button>
            <button class="cancel" disabled={busy} onclick={() => void resolveConfirmation(false)}>Cancel</button>
          </div>
        </section>
      {/if}
      {#if busy}<div class="thinking">Resolving…</div>{/if}
      </div>

      <div class="composer-shell">
        {#if currentChatContext}
          <div class="composer-context" title={`${currentChatContext.kind}: ${currentChatContext.title}`}>
            <span aria-hidden="true" class="codicon codicon-file"></span>
            <span class="composer-context-kind">{currentChatContext.kind}</span>
            <span class="composer-context-title">{currentChatContext.title}</span>
          </div>
        {:else}
          <div class="composer-context composer-context-empty">No document selected</div>
        {/if}
        <form class="composer" onsubmit={(event) => { event.preventDefault(); void send(); }}>
          <textarea bind:value={input} rows="3" aria-label="Message" onkeydown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
          }}></textarea>
          <button class="send" disabled={busy || pendingConfirmation !== null || !input.trim()} title="Send" aria-label="Send">↑</button>
        </form>
      </div>
    {/if}
  </aside>
</div>