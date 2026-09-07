<script lang="ts">
  import { onMount, tick } from 'svelte';
  import ActiveRail from './ActiveRail.svelte';
  import WorkstreamView from '../../../webview-ui/src/lib/WorkstreamView.svelte';
  import TopicView from '../../../webview-ui/src/lib/TopicView.svelte';
  import DocumentView from '../../../webview-ui/src/lib/DocumentView.svelte';
  import type { AlertVM, DocumentVM, SaveState, TopicPatch } from '../../../webview-ui/src/lib/types';
  import { chatContextForDocument } from '../shared/contracts';
  import type {
    ChatResult,
    DesktopEnvironment,
    DesktopEnvironmentState,
    DesktopResourceKind,
    PendingConfirmation,
    PublicConfig,
  } from '../shared/contracts';
  import type { CommandJournalScopeRef } from '../../../src/controlPlaneClient';
  import type { PanelAction, PanelData } from '../../../src/panelData';
  import { invokeActiveAction } from './activeContextMenu';
  import { isChatAtBottom } from './chatScroll';
  import { readComposerDraft, writeComposerDraft } from './composerDraft';
  import { renderMarkdown } from './markdown';
  import {
    closeDocumentTab,
    documentTabKey,
    openDocumentTab,
    replaceSelectedTab,
    updateDocumentTab,
  } from './documentTabs';
  import { chatRunDomId, recentRunsForContext } from './scopedChat';
  import { RAIL_LAYOUT, parseStoredRailWidth, resizeRail, resolveRailWidths } from './railLayout';
  import type { RailSide, RailWidths } from './railLayout';
  import {
    emptyEnvironmentBoundRendererState,
    reloadEnvironmentBoundData,
    type SelectedTool,
  } from './environmentState';
  import {
    createLiveRun,
    formatDetailValue,
    journalToSummary,
    mergeHistoryRuns,
    reconcileLiveRun,
    targetForRef,
    toolDetail,
    type ChatRun,
    type ChatToolRow,
    type ToolDetail,
  } from './chatHistory';

  type Page = 'workspace' | 'settings';
  const HISTORY_PAGE_SIZE = 30;

  let page = $state<Page>('workspace');
  let input = $state('');
  let chatRuns = $state<ChatRun[]>([]);
  let historyLoading = $state(true);
  let historyError = $state('');
  let historyCursor = $state<string | undefined>();
  let selectedTool = $state<SelectedTool | null>(null);
  let toolInspectorElement = $state<HTMLElement | null>(null);
  let pendingRunKey = $state<string | null>(null);
  let documents = $state<DocumentVM[]>([]);
  let selectedDocumentKey = $state<string | null>(null);
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
  let environments = $state<DesktopEnvironment[]>([]);
  let selectedEnvironment = $state<DesktopEnvironment | null>(null);
  let environmentLoading = $state(false);
  let environmentError = $state('');
  let activePanel = $state<PanelData | null>(null);
  let activeLoading = $state(false);
  let activeError = $state('');
  let activeRailCollapsed = $state(false);
  let chatRailCollapsed = $state(false);
  let activeRailWidth = $state(RAIL_LAYOUT.active.default);
  let chatRailWidth = $state(RAIL_LAYOUT.chat.default);
  let viewportWidth = $state(1280);
  let railDrag: { side: RailSide; startX: number; widths: RailWidths } | null = null;
  let conversationElement = $state<HTMLDivElement | null>(null);
  let conversationPinned = true;
  let hasUnseenMessages = $state(false);
  let environmentGeneration = 0;
  const activeDocument = $derived(documents.find((document) => documentTabKey(document) === selectedDocumentKey) ?? null);
  const currentChatContext = $derived(chatContextForDocument(activeDocument));
  const scopedRecentRuns = $derived(recentRunsForContext(chatRuns, currentChatContext));
  const resolvedRailWidths = $derived(resolveRailWidths(
    { active: activeRailWidth, chat: chatRailWidth },
    viewportWidth,
    { active: activeRailCollapsed, chat: chatRailCollapsed },
  ));

  const RAIL_STORAGE_KEYS = {
    active: 'working-memory.desktop.active-rail-width',
    chat: 'working-memory.desktop.chat-rail-width',
  } as const;

  async function applyChatResult(result: ChatResult, runKey: string): Promise<void> {
    chatRuns = reconcileLiveRun(chatRuns, runKey, result);
    pendingConfirmation = result.pendingConfirmation ?? null;
    pendingRunKey = result.pendingConfirmation ? (result.journalId ?? runKey) : null;
    const document = result.document ?? result.workstream;
    if (document) {
      const next = openDocumentTab({ tabs: documents, selectedKey: selectedDocumentKey }, document);
      documents = next.tabs;
      selectedDocumentKey = next.selectedKey;
      documentError = '';
    }
    if (result.journalId) await refreshJournal(result.journalId);
    void refreshActive();
  }

  function liveScope(): CommandJournalScopeRef {
    return currentChatContext
      ? { kind: currentChatContext.kind, id: currentChatContext.identifier, title: currentChatContext.title }
      : { kind: 'DesktopChat', id: 'desktop-chat' };
  }

  async function refreshJournal(id: string): Promise<void> {
    const generation = environmentGeneration;
    try {
      const journal = await window.workingMemory.getChatJournal(id);
      if (generation !== environmentGeneration) return;
      if (journal) chatRuns = mergeHistoryRuns(chatRuns, [journalToSummary(journal)]);
    } catch {
      // The live result remains usable while a transient history refresh fails.
    }
  }

  async function loadHistory(older = false): Promise<void> {
    if (historyLoading && older) return;
    const previousHeight = conversationElement?.scrollHeight ?? 0;
    const previousTop = conversationElement?.scrollTop ?? 0;
    historyLoading = true;
    historyError = '';
    const generation = environmentGeneration;
    try {
      const historyPage = await window.workingMemory.getChatHistory({
        limit: HISTORY_PAGE_SIZE,
        ...(older && historyCursor ? { cursor: historyCursor } : {}),
      });
      if (generation !== environmentGeneration) return;
      chatRuns = mergeHistoryRuns(chatRuns, historyPage.journals);
      historyCursor = historyPage.nextCursor;
      if (older) {
        await tick();
        if (conversationElement) {
          conversationElement.scrollTop = previousTop + conversationElement.scrollHeight - previousHeight;
          conversationPinned = false;
        }
      }
    } catch (error) {
      if (generation !== environmentGeneration) return;
      historyError = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === environmentGeneration) historyLoading = false;
    }
  }

  async function openToolDetail(row: ChatToolRow): Promise<void> {
    selectedTool = { row, loading: true, error: '' };
    await tick();
    toolInspectorElement?.focus();
    try {
      const journal = await window.workingMemory.getChatJournal(row.journalId);
      const detail = journal ? toolDetail(journal, row.sequence) : undefined;
      selectedTool = detail
        ? { row, detail, loading: false, error: '' }
        : { row, loading: false, error: 'This tool event is no longer available.' };
    } catch (error) {
      selectedTool = { row, loading: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  function assistantFallback(run: ChatRun): string {
    if (run.status === 'awaiting_confirmation') return 'Awaiting confirmation.';
    if (run.status === 'running' || run.status === 'submitting') return 'Running…';
    if (run.status === 'interrupted') return 'Interrupted before an assistant response.';
    if (run.status === 'cancelled') return 'Cancelled before an assistant response.';
    if (run.status === 'failed') return 'Failed before an assistant response.';
    return 'Completed without an assistant response.';
  }

  function handleConversationScroll(): void {
    if (!conversationElement) return;
    conversationPinned = isChatAtBottom(conversationElement);
    if (conversationPinned) hasUnseenMessages = false;
  }

  function scrollConversationToBottom(behavior: ScrollBehavior = 'auto'): void {
    if (!conversationElement) return;
    conversationElement.scrollTo({ top: conversationElement.scrollHeight, behavior });
    conversationPinned = true;
    hasUnseenMessages = false;
  }

  $effect(() => {
    void chatRuns.length;
    void busy;
    void pendingConfirmation;
    const shouldStick = conversationPinned;
    void tick().then(() => {
      if (shouldStick) scrollConversationToBottom();
      else hasUnseenMessages = true;
    });
  });

  onMount(() => {
    activeRailWidth = parseStoredRailWidth(localStorage.getItem(RAIL_STORAGE_KEYS.active), 'active');
    chatRailWidth = parseStoredRailWidth(localStorage.getItem(RAIL_STORAGE_KEYS.chat), 'chat');
    viewportWidth = window.innerWidth;
    const handleResize = () => { viewportWidth = window.innerWidth; };
    window.addEventListener('resize', handleResize);
    void window.workingMemory.getConfig().then(loadConfig);
    void discoverEnvironments(true);
    void refreshActive();
    void loadHistory();
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
    const generation = environmentGeneration;
    try {
      const panel = await window.workingMemory.getActivePanel();
      if (generation !== environmentGeneration) return;
      activePanel = panel;
      if (activePanel.items.length === 0 && activePanel.emptyMessage !== 'No active workstreams.') {
        activeError = activePanel.emptyMessage;
      }
    } catch (error) {
      if (generation !== environmentGeneration) return;
      activeError = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === environmentGeneration) activeLoading = false;
    }
  }

  function applyEnvironmentState(state: DesktopEnvironmentState): void {
    environments = state.environments;
    selectedEnvironment = state.selected;
  }

  async function discoverEnvironments(restoreDraft = false): Promise<void> {
    environmentLoading = true;
    environmentError = '';
    try {
      applyEnvironmentState(await window.workingMemory.discoverEnvironments());
      if (restoreDraft) input = readComposerDraft(localStorage, selectedEnvironment?.id);
    } catch (error) {
      environmentError = error instanceof Error ? error.message : String(error);
    } finally {
      environmentLoading = false;
    }
  }

  function resetEnvironmentState(): void {
    const reset = emptyEnvironmentBoundRendererState();
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
    input = reset.input;
    documents = reset.documents;
    selectedDocumentKey = null;
    saveState = reset.saveState;
    documentError = reset.documentError;
    chatRuns = reset.chatRuns;
    historyLoading = reset.historyLoading;
    historyError = reset.historyError;
    historyCursor = reset.historyCursor;
    selectedTool = reset.selectedTool;
    pendingRunKey = reset.pendingRunKey;
    busy = reset.busy;
    pendingConfirmation = reset.pendingConfirmation;
    activePanel = reset.activePanel;
    activeLoading = reset.activeLoading;
    activeError = reset.activeError;
    hasUnseenMessages = reset.hasUnseenMessages;
    conversationPinned = true;
    page = 'workspace';
  }

  async function switchEnvironment(mcpUrl: string): Promise<void> {
    environmentLoading = true;
    environmentError = '';
    try {
      const state = await window.workingMemory.switchEnvironment(mcpUrl);
      environmentGeneration += 1;
      resetEnvironmentState();
      applyEnvironmentState(state);
      input = readComposerDraft(localStorage, selectedEnvironment?.id);
      await reloadEnvironmentBoundData(refreshActive, () => loadHistory());
    } catch (error) {
      environmentError = error instanceof Error ? error.message : String(error);
    } finally {
      environmentLoading = false;
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
    const runKey = crypto.randomUUID();
    chatRuns = [...chatRuns, createLiveRun(runKey, message, liveScope(), Date.now())];
    input = '';
    writeComposerDraft(localStorage, selectedEnvironment?.id, '');
    busy = true;
    const generation = environmentGeneration;
    try {
      const result = await window.workingMemory.sendChat(message, currentChatContext);
      if (generation === environmentGeneration) await applyChatResult(result, runKey);
    } catch (error) {
      if (generation !== environmentGeneration) return;
      chatRuns = chatRuns.map((run) => run.key === runKey
        ? { ...run, status: 'failed', assistantText: `Unable to complete that request: ${error instanceof Error ? error.message : String(error)}` }
        : run);
    } finally {
      if (generation === environmentGeneration) busy = false;
    }
  }

  function updateComposerDraft(value: string): void {
    input = value;
    writeComposerDraft(localStorage, selectedEnvironment?.id, value);
  }

  async function resolveConfirmation(confirmed: boolean): Promise<void> {
    const pending = pendingConfirmation;
    const runKey = pendingRunKey;
    if (!pending || !runKey || busy) return;
    busy = true;
    pendingConfirmation = null;
    const generation = environmentGeneration;
    try {
      const result = await window.workingMemory.resolveChatConfirmation(pending.id, confirmed, currentChatContext);
      if (generation === environmentGeneration) await applyChatResult(result, runKey);
    } catch (error) {
      if (generation !== environmentGeneration) return;
      chatRuns = chatRuns.map((run) => run.key === runKey || run.journalId === runKey
        ? { ...run, status: 'failed', assistantText: `Unable to resolve that action: ${error instanceof Error ? error.message : String(error)}` }
        : run);
    } finally {
      if (generation === environmentGeneration) busy = false;
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

  function replaceActive(document: DocumentVM, key = selectedDocumentKey): void {
    const next = key
      ? updateDocumentTab({ tabs: documents, selectedKey: selectedDocumentKey }, key, document)
      : replaceSelectedTab({ tabs: documents, selectedKey: selectedDocumentKey }, document);
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
  }

  async function openResource(kind: DesktopResourceKind, identifier: string): Promise<void> {
    try {
      const document = await window.workingMemory.openResource(kind, identifier);
      const next = openDocumentTab({ tabs: documents, selectedKey: selectedDocumentKey }, document);
      documents = next.tabs;
      selectedDocumentKey = next.selectedKey;
      documentError = '';
      saveState = 'idle';
    } catch (error) {
      documentError = error instanceof Error ? error.message : String(error);
    }
  }

  async function mutate(operation: () => Promise<DocumentVM>): Promise<void> {
    const targetKey = selectedDocumentKey;
    saveState = 'saving';
    documentError = '';
    try {
      replaceActive(await operation(), targetKey);
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
      const key = `workstream:${workstream}`;
      if (documents.some((candidate) => documentTabKey(candidate) === key)) replaceActive(document, key);
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

  function selectDocument(key: string): void {
    if (documents.some((document) => documentTabKey(document) === key)) {
      selectedDocumentKey = key;
      documentError = '';
    }
  }

  function closeDocument(key: string): void {
    const next = closeDocumentTab({ tabs: documents, selectedKey: selectedDocumentKey }, key);
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
    documentError = '';
  }

  async function focusChatRun(run: ChatRun): Promise<void> {
    await tick();
    document.getElementById(chatRunDomId(run))?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById(chatRunDomId(run))?.focus({ preventScroll: true });
  }
</script>

<svelte:window
  onclick={handleDocumentClick}
  onkeydown={(event) => { if (event.key === 'Escape' && selectedTool) selectedTool = null; }}
/>

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
      {#key selectedEnvironment?.id ?? 'no-environment'}
        <ActiveRail
          {environments}
          {selectedEnvironment}
          {environmentLoading}
          {environmentError}
          data={activePanel}
          loading={activeLoading}
          error={activeError}
          onDiscoverEnvironments={discoverEnvironments}
          onSwitchEnvironment={switchEnvironment}
          onRefresh={() => void refreshActive()}
          onSettings={() => (page = page === 'settings' ? 'workspace' : 'settings')}
          onCollapse={() => (activeRailCollapsed = true)}
          onOpen={openRoute}
          onToggleFocus={toggleActiveFocus}
          onAction={runActiveAction}
        />
      {/key}
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
    <div class="stage-content">
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
      <div class="document-stage">
        <div class="document-tabs" role="tablist" aria-label="Open documents">
          {#each documents as document (documentTabKey(document))}
            {@const key = documentTabKey(document)}
            <div class="document-tab" class:selected={key === selectedDocumentKey}>
              <button
                class="document-tab-select"
                role="tab"
                aria-selected={key === selectedDocumentKey}
                title={document.title}
                onclick={() => selectDocument(key)}
              >
                <span aria-hidden="true" class="codicon codicon-{document.kind === 'workstream' ? 'briefcase' : document.kind === 'topic' ? (document.typeMeta?.icon ?? 'symbol-misc') : 'file'}"></span>
                <span>{document.title}</span>
              </button>
              <button class="document-tab-close" title={`Close ${document.title}`} aria-label={`Close ${document.title}`} onclick={() => closeDocument(key)}>
                <span aria-hidden="true" class="codicon codicon-close"></span>
              </button>
            </div>
          {/each}
        </div>
        <div class="document-host" role="tabpanel">
          <div class="document-toolbar">
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
      </div>
    {:else}
      <section class="empty-state">
        <p class="eyebrow">Control plane view</p>
        <h1>Choose active work.</h1>
        <p>Open a workstream, topic, or nanite from the Active rail, or ask through chat.</p>
      </section>
    {/if}
    </div>

    {#if page === 'workspace'}
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
          <textarea
            value={input}
            rows="3"
            aria-label="Message"
            placeholder="Write a command to interact with Working Memory"
            oninput={(event) => updateComposerDraft(event.currentTarget.value)}
            onkeydown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
            }}></textarea>
          <button class="send" disabled={busy || pendingConfirmation !== null || !input.trim()} title="Send" aria-label="Send">
            <span aria-hidden="true" class="codicon codicon-send"></span>
          </button>
        </form>
      </div>
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

      <section class="scope-preview" aria-label="Recent messages for current document">
        <div class="scope-preview-heading">
          <span>Current file</span>
          <strong>{currentChatContext?.title ?? 'No document selected'}</strong>
        </div>
        {#if scopedRecentRuns.length === 0}
          <p>No messages for this scope.</p>
        {:else}
          {#each scopedRecentRuns as run (run.journalId ?? run.key)}
            <button onclick={() => void focusChatRun(run)} title="Show in history">
              <span>{run.userText}</span>
              <small>{run.assistantText ?? assistantFallback(run)}</small>
            </button>
          {/each}
        {/if}
      </section>

      <div class="conversation-shell">
      <div bind:this={conversationElement} class="conversation" aria-live="polite" onscroll={handleConversationScroll}>
      {#if historyCursor}
        <button class="load-older" disabled={historyLoading} onclick={() => void loadHistory(true)}>
          {historyLoading ? 'Loading…' : 'Load older'}
        </button>
      {/if}
      {#if historyLoading && chatRuns.length === 0}
        <div class="history-state">Loading history…</div>
      {:else if historyError && chatRuns.length === 0}
        <div class="history-state history-error" role="alert">{historyError}</div>
      {:else if chatRuns.length === 0}
        <div class="history-state">No chat history.</div>
      {/if}
      {#if historyError && chatRuns.length > 0}
        <div class="history-state history-error" role="alert">{historyError}</div>
      {/if}
      {#each chatRuns as run (run.key)}
        {@const scopeTarget = targetForRef(run.scope)}
        <article id={chatRunDomId(run)} class="chat-run" data-journal-id={run.journalId} tabindex="-1">
          <section class="user-entry">
            {#if scopeTarget}
              <button class="user-scope" onclick={() => void openResource(scopeTarget.kind, scopeTarget.identifier)}>
                <span aria-hidden="true" class="codicon codicon-link"></span>
                {run.scope.title ?? run.scope.slug ?? run.scope.id}
              </button>
            {:else}
              <span class="user-scope unsupported">{run.scope.title ?? run.scope.slug ?? run.scope.id}</span>
            {/if}
            <pre>{run.userText}</pre>
          </section>

          {#if run.tools.length}
            <ol class="tool-rows" aria-label="Tool activity">
              {#each run.tools as tool (`${tool.journalId}:${tool.sequence}`)}
                <li class:failed={tool.status === 'failure'} class:cancelled={tool.status === 'cancelled'}>
                  <button class="tool-row-main" onclick={() => void openToolDetail(tool)} aria-label={`Inspect ${tool.toolName}`}>
                    <span aria-hidden="true" class={`codicon codicon-${tool.mode === 'write' ? 'edit' : 'book'}`}></span>
                    <span>{tool.toolName}</span>
                    <span class="tool-status">{tool.status}</span>
                  </button>
                  {#if tool.entity?.target}
                    <button
                      class="tool-entity"
                      title={`Open ${tool.entity.label}`}
                      onclick={() => void openResource(tool.entity!.target!.kind, tool.entity!.target!.identifier)}
                    >{tool.entity.label}</button>
                  {:else if tool.entity}
                    <span class="tool-entity unsupported">{tool.entity.label}</span>
                  {/if}
                </li>
              {/each}
            </ol>
          {:else if run.progress?.length}
            <ul class="tool-progress">
              {#each run.progress as item}
                <li class:failed={item.status === 'failed'}>{item.name}: {item.summary}</li>
              {/each}
            </ul>
          {/if}

          <section class="assistant-entry" class:partial={!run.assistantText}>
            <span>WM</span>
            {#if run.assistantText}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              <div class="assistant-markdown">{@html renderMarkdown(run.assistantText)}</div>
            {:else}
              <p>{assistantFallback(run)}</p>
            {/if}
          </section>
        </article>
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
      {#if hasUnseenMessages}
        <button class="new-message-indicator" aria-label="Jump to newest message" title="Jump to newest message" onclick={() => scrollConversationToBottom('smooth')}>
          <span aria-hidden="true" class="codicon codicon-chevron-down"></span>
          <span>New messages</span>
        </button>
      {/if}
      </div>

      {#if selectedTool}
        <div class="tool-inspector-backdrop" role="presentation" onclick={() => (selectedTool = null)}>
          <div
            bind:this={toolInspectorElement}
            class="tool-inspector"
            role="dialog"
            aria-modal="true"
            aria-labelledby="tool-inspector-title"
            tabindex="-1"
            onclick={(event) => event.stopPropagation()}
            onkeydown={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>{selectedTool.row.mode}</span>
                <h2 id="tool-inspector-title">{selectedTool.row.toolName}</h2>
              </div>
              <button class="icon-button" title="Close" aria-label="Close tool detail" onclick={() => (selectedTool = null)}>
                <span aria-hidden="true" class="codicon codicon-close"></span>
              </button>
            </header>
            {#if selectedTool.loading}
              <div class="inspector-state">Loading…</div>
            {:else if selectedTool.error}
              <div class="inspector-state history-error" role="alert">{selectedTool.error}</div>
            {:else if selectedTool.detail}
              {@const detail = selectedTool.detail}
              <dl class="tool-metadata">
                <div><dt>Status</dt><dd>{detail.result?.status ?? 'missing'}</dd></div>
                <div><dt>Duration</dt><dd>{detail.result ? `${detail.result.durationMs} ms` : 'unavailable'}</dd></div>
                {#if detail.call.retryOfCallId}<div><dt>Retry of</dt><dd>{detail.call.retryOfCallId}</dd></div>{/if}
                {#if detail.call.dedupedOfCallId}<div><dt>Deduped from</dt><dd>{detail.call.dedupedOfCallId}</dd></div>{/if}
              </dl>
              <section>
                <h3>Arguments</h3>
                {#if detail.call.argumentParseError}
                  <pre class="detail-error">{detail.call.argumentParseError}</pre>
                {:else}
                  <pre>{formatDetailValue(detail.call.arguments)}</pre>
                {/if}
              </section>
              {#if detail.confirmation}
                <section>
                  <h3>Confirmation</h3>
                  <p>{detail.confirmation.requested?.prompt ?? 'Confirmation requested'}</p>
                  <p>{detail.confirmation.resolved?.resolution ?? 'Unresolved'}</p>
                </section>
              {/if}
              <section>
                <h3>{detail.result?.status === 'failure' ? 'Error' : detail.result?.status === 'cancelled' ? 'Cancelled' : 'Result'}</h3>
                {#if detail.partial}
                  <p class="partial-detail">No result was persisted. This run is partial or was interrupted.</p>
                {:else if detail.result?.status === 'failure'}
                  <pre class="detail-error">{formatDetailValue(detail.result.error)}</pre>
                {:else if detail.result?.status === 'cancelled'}
                  <pre>{formatDetailValue(detail.result.error) || 'Cancelled'}</pre>
                {:else}
                  <pre>{formatDetailValue(detail.result?.result)}</pre>
                {/if}
              </section>
            {/if}
          </div>
        </div>
      {/if}

    {/if}
  </aside>
</div>