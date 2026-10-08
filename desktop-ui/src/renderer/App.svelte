<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import ActiveRail from './ActiveRail.svelte';
  import ContainerAppDetail from './ContainerAppDetail.svelte';
  import ContainerAppList from './ContainerAppList.svelte';
  import WorkstreamView from './documents/WorkstreamView.svelte';
  import TopicView from './documents/TopicView.svelte';
  import TopicCreateView from './documents/TopicCreateView.svelte';
  import TopicBacklogView from './documents/TopicBacklogView.svelte';
  import SettingsView from './documents/SettingsView.svelte';
  import DocumentView from './documents/DocumentView.svelte';
  import type {
    AlertVM,
    AttachmentRef,
    DocumentVM,
    SaveState,
    TopicPatch,
    TopicCreateDraftVM,
    TopicBacklogVM,
    WorkstreamVM,
  } from './documents/types';
  import { chatContextForDocument } from '../shared/contracts';
  import type {
    ChatResult,
    BackendHealth,
    ChatPromptImage,
    ContainerAppStatus,
    DesktopEnvironment,
    DesktopEnvironmentState,
    DesktopResourceKind,
    EditableModelProfile,
    ModelRouting,
    PendingConfirmation,
    PublicConfig,
  } from '../shared/contracts';
  import {
    containerAppDocument,
    containerAppIdForDocument,
    loadRegisteredContainerApps,
    type ContainerAppItem,
  } from './containerApps';
  import type { CommandJournalScopeRef } from '../../../shared/controlPlaneClient';
  import type { PanelAction, PanelData } from '../../../shared/panelData';
  import { invokeActiveAction } from './activeContextMenu';
  import { DESKTOP_BUILD_TIMESTAMP, formatDesktopBuildTimestamp } from './buildInfo';
  import { isChatAtBottom } from './chatScroll';
  import { readComposerDraft, writeComposerDraft } from './composerDraft';
  import {
    filterMentionApps,
    mentionKeyEventAction,
    mentionTokenAtCaret,
    replaceMentionToken,
    type MentionToken,
  } from './mentionCompletion';
  import { renderMarkdown } from './markdown';
  import { imageFilesFromTransfer } from './documents/imageFiles';
  import { validateChatImage } from './chatImages';
  import { createDocumentSaveQueue } from './documentSaveQueue';
  import {
    closeDocumentTab,
    closeDocumentTabsToRight,
    closeOtherDocumentTabs,
    documentTabKey,
    openDocumentTab,
    replaceSelectedTab,
    updateDocumentTab,
  } from './documentTabs';
  import { chatRunDomId, recentRunsForContext } from './scopedChat';
  import { humanInitials } from './humanIdentity';
  import { CHAT_HISTORY_POLL_INTERVAL_MS } from './chatPolling';
  import { focusChatRunTarget } from './chatRunFocus';
  import { RAIL_LAYOUT, parseStoredRailWidth, resizeRail, resolveRailWidths } from './railLayout';
  import { planWorkstreamReorder } from './workstreamReorder';
  import { topicTransferRefreshTargets, type TopicTransferRequest } from './topicTransfer';
  import type { WorkstreamSection } from '../../../shared/panelData';
  import type { RailSide, RailWidths } from './railLayout';
  import {
    emptyEnvironmentBoundRendererState,
    reloadEnvironmentBoundData,
    type SelectedTool,
  } from './environmentState';
  import {
    chatContextForScope,
    createLiveRun,
    formatDetailValue,
    isRetryableRun,
    journalToSummary,
    mergeHistoryRuns,
    reconcileLiveRun,
    refreshLatestRuns,
    targetForRef,
    toolDetail,
    type ChatRun,
    type ChatToolRow,
    type ToolDetail,
  } from './chatHistory';

  type HeaderTab = 'log' | 'container-apps';
  const HISTORY_PAGE_SIZE = 30;
  const HEADER_TABS: HeaderTab[] = ['log', 'container-apps'];
  const AI_SPEEDS = ['slow', 'medium', 'fast'] as const;
  const AI_DEPTHS = [
    { id: 'simple', label: 'Simple' },
    { id: 'complex', label: 'Complex' },
    { id: 'deep', label: 'Deep Thought' },
  ] as const;
  const desktopBuildLabel = formatDesktopBuildTimestamp(DESKTOP_BUILD_TIMESTAMP);

  interface ComposerImage {
    attachment: AttachmentRef;
    previewUrl: string;
  }

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
  let documentSaveStates = $state<Record<string, SaveState>>({});
  let documentSaveErrors = $state<Record<string, string>>({});
  let documentTabMenu = $state<{ x: number; y: number; key: string } | null>(null);
  let documentTabMenuElement = $state<HTMLDivElement | null>(null);
  let busy = $state(false);
  let endpoint = $state('');
  let credentialStorage = $state<PublicConfig['credentialStorage']>('secure');
  let modelProfiles = $state<Array<EditableModelProfile & { apiKey: string }>>([]);
  let modelRouting = $state<ModelRouting>({} as ModelRouting);
  let humanName = $state('Flesh Bag');
  let settingsStatus = $state('');
  let saving = $state(false);
  let testingProfileId = $state<string | null>(null);
  let pendingConfirmation = $state<PendingConfirmation | null>(null);
  let environments = $state<DesktopEnvironment[]>([]);
  let selectedEnvironment = $state<DesktopEnvironment | null>(null);
  let environmentLoading = $state(false);
  let environmentError = $state('');
  let containerAppStatuses = $state<Record<string, ContainerAppStatus | undefined>>({});
  let containerApps = $state<ContainerAppItem[]>([]);
  let containerAppError = $state('');
  let activeHeaderTab = $state<HeaderTab>('log');
  let focusedHeaderTab = $state<HeaderTab>('log');
  let busyContainerAppId = $state<string | null>(null);
  let backendHealth = $state<BackendHealth | null>(null);
  let backendHealthChecking = $state(false);
  let openAiHealth = $state<{
    state: 'healthy' | 'degraded' | 'unreachable' | 'unknown';
    result: string;
    observedAt: number;
  }>({ state: 'unknown', result: 'No backend request observed yet.', observedAt: 0 });
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
  let composerElement = $state<HTMLFormElement | null>(null);
  let composerTextarea = $state<HTMLTextAreaElement | null>(null);
  let composerImages = $state<ComposerImage[]>([]);
  let composerImageError = $state('');
  let composerImageWorking = $state(false);
  let cameraOpen = $state(false);
  let cameraError = $state('');
  let cameraVideo = $state<HTMLVideoElement | null>(null);
  let cameraCapture: File | null = null;
  let cameraCaptureUrl = $state('');
  let cameraStream: MediaStream | null = null;
  let mentionToken = $state<MentionToken | null>(null);
  let mentionActiveIndex = $state(0);
  let conversationPinned = true;
  let hasUnseenMessages = $state(false);
  let scopePreviewExpanded = $state(false);
  let previewAttentionTarget: HTMLElement | null = null;
  let previewAttentionTimer: number | undefined;
  let environmentGeneration = 0;
  let historyRequestGeneration: number | null = null;
  const activeDocument = $derived(documents.find((document) => documentTabKey(document) === selectedDocumentKey) ?? null);
  const selectedContainerAppId = $derived(containerAppIdForDocument(activeDocument));
  const selectedContainerApp = $derived(containerApps.find((app) => app.id === selectedContainerAppId) ?? null);
  const currentChatContext = $derived(chatContextForDocument(activeDocument));
  const mentionApps = $derived(mentionToken ? filterMentionApps(containerApps, mentionToken.query) : []);
  const mentionOpen = $derived(mentionToken !== null);

  function appAdvertisesMcp(app: ContainerAppItem): boolean {
    const status = containerAppStatuses[app.id];
    return status ? Boolean(status.mcp) : Boolean(app.mcp);
  }

  function closeMentionCompletion(): void {
    mentionToken = null;
    mentionActiveIndex = 0;
  }

  function refreshMentionCompletion(value: string, caret: number | null): void {
    mentionToken = mentionTokenAtCaret(value, caret ?? value.length, containerApps);
    mentionActiveIndex = 0;
  }

  async function selectMention(app: ContainerAppItem): Promise<void> {
    const token = mentionToken;
    if (!token) return;
    const replacement = replaceMentionToken(input, token, app.id);
    input = replacement.value;
    writeComposerDraft(localStorage, selectedEnvironment?.id, input);
    closeMentionCompletion();
    await tick();
    composerTextarea?.focus();
    composerTextarea?.setSelectionRange(replacement.caret, replacement.caret);
  }

  function handleComposerInput(event: Event): void {
    const textarea = event.currentTarget as HTMLTextAreaElement;
    updateComposerDraft(textarea.value);
    refreshMentionCompletion(textarea.value, textarea.selectionStart);
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    const action = mentionKeyEventAction(event, mentionOpen, mentionApps.length, mentionActiveIndex);
    if (action.type === 'none') return;
    if (action.type === 'navigate') mentionActiveIndex = action.index;
    else if (action.type === 'dismiss') closeMentionCompletion();
    else if (action.type === 'select') void selectMention(mentionApps[action.index]);
    else if (action.type === 'send') void send();
  }

  function handleComposerBlur(): void {
    window.setTimeout(() => {
      if (!composerElement?.contains(document.activeElement)) closeMentionCompletion();
    }, 0);
  }

  function chatAttachmentUrl(id: string): string {
    if (!selectedEnvironment?.mcpUrl) return '';
    return `${new URL(selectedEnvironment.mcpUrl).origin}/attachments/${encodeURIComponent(id)}`;
  }

  function clearComposerImages(): void {
    for (const image of composerImages) URL.revokeObjectURL(image.previewUrl);
    composerImages = [];
  }

  function removeComposerImage(index: number): void {
    const image = composerImages[index];
    if (!image) return;
    URL.revokeObjectURL(image.previewUrl);
    composerImages = composerImages.filter((_, current) => current !== index);
  }

  async function addComposerImages(files: File[]): Promise<void> {
    if (files.length === 0 || composerImageWorking) return;
    composerImageError = '';
    const validationError = files.map(validateChatImage).find(Boolean);
    if (validationError) {
      composerImageError = validationError;
      return;
    }
    composerImageWorking = true;
    try {
      const attachments = await attachImages(files);
      composerImages = [
        ...composerImages,
        ...attachments.map((attachment, index) => ({
          attachment,
          previewUrl: URL.createObjectURL(files[index]),
        })),
      ];
    } catch (error) {
      composerImageError = error instanceof Error ? error.message : String(error);
    } finally {
      composerImageWorking = false;
    }
  }

  function handleComposerPaste(event: ClipboardEvent): void {
    const files = imageFilesFromTransfer(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void addComposerImages(files);
  }

  function stopCameraStream(): void {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    if (cameraVideo) cameraVideo.srcObject = null;
  }

  function clearCameraCapture(): void {
    if (cameraCaptureUrl) URL.revokeObjectURL(cameraCaptureUrl);
    cameraCaptureUrl = '';
    cameraCapture = null;
  }

  async function openCamera(): Promise<void> {
    cameraError = '';
    clearCameraCapture();
    if (!navigator.mediaDevices?.getUserMedia) {
      cameraError = 'Camera capture is unavailable in this environment.';
      cameraOpen = true;
      return;
    }
    cameraOpen = true;
    await tick();
    try {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (!cameraVideo) throw new Error('Camera preview could not be initialized.');
      cameraVideo.srcObject = cameraStream;
      await cameraVideo.play();
    } catch (error) {
      stopCameraStream();
      cameraError = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow camera access in System Settings and try again.'
        : `Unable to open camera: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function captureCameraImage(): void {
    if (!cameraVideo || cameraVideo.videoWidth === 0 || cameraVideo.videoHeight === 0) {
      cameraError = 'The camera is not ready yet.';
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = cameraVideo.videoWidth;
    canvas.height = cameraVideo.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      cameraError = 'Unable to capture a camera frame.';
      return;
    }
    context.drawImage(cameraVideo, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) {
        cameraError = 'Unable to encode the captured image.';
        return;
      }
      clearCameraCapture();
      cameraCapture = new File([blob], `camera-${Date.now()}.jpg`, { type: 'image/jpeg' });
      cameraCaptureUrl = URL.createObjectURL(cameraCapture);
      stopCameraStream();
    }, 'image/jpeg', 0.92);
  }

  async function retakeCameraImage(): Promise<void> {
    clearCameraCapture();
    await openCamera();
  }

  async function confirmCameraImage(): Promise<void> {
    if (!cameraCapture) return;
    const capture = cameraCapture;
    cameraOpen = false;
    clearCameraCapture();
    await addComposerImages([capture]);
  }

  function closeCamera(): void {
    stopCameraStream();
    clearCameraCapture();
    cameraOpen = false;
    cameraError = '';
  }

  onDestroy(() => {
    clearComposerImages();
    closeCamera();
  });

  async function refreshContainerApp(app: ContainerAppItem): Promise<void> {
    const generation = environmentGeneration;
    try {
      const status = await window.workingMemory.inspectContainerApp(app.id);
      if (generation === environmentGeneration) {
        containerAppStatuses[app.id] = status;
        containerAppError = status.error ?? '';
      }
    } catch (error) {
      if (generation === environmentGeneration) containerAppError = error instanceof Error ? error.message : String(error);
    }
  }

  async function loadContainerApps(): Promise<void> {
    try {
      await loadRegisteredContainerApps(
        () => window.workingMemory.listContainerApps(),
        (id) => window.workingMemory.inspectContainerApp(id),
        () => environmentGeneration,
        (apps) => { containerApps = apps; },
        (app, status) => {
          containerAppStatuses[app.id] = status;
          if (status.error) containerAppError = status.error;
        },
        (error) => {
          containerAppError = error instanceof Error ? error.message : String(error);
        },
      );
    } catch (error) {
      containerAppError = error instanceof Error ? error.message : String(error);
    }
  }

  async function openContainerAppDetail(app: ContainerAppItem): Promise<void> {
    const next = openDocumentTab(
      { tabs: documents, selectedKey: selectedDocumentKey },
      containerAppDocument(app),
    );
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
    activateHeaderTab('container-apps');
    restoreDocumentSaveStatus(next.selectedKey);
    await refreshContainerApp(app);
  }

  async function runContainerAppAction(app: ContainerAppItem, action: 'run' | 'open' | 'stop' | 'refresh'): Promise<void> {
    if (busyContainerAppId) return;
    const generation = environmentGeneration;
    busyContainerAppId = app.id;
    containerAppError = '';
    try {
      if (action === 'run') {
        const result = await window.workingMemory.runContainerApp(app.id);
        const status = await window.workingMemory.inspectContainerApp(app.id);
        if (generation !== environmentGeneration) return;
        observeOpenAi('unreachable', error instanceof Error ? error.message : String(error));
        containerAppStatuses[app.id] = result.status === 'ready'
          ? { ...status, lastAction: `Run: ${result.action}`, error: null }
          : { ...status, lastAction: 'Run failed', error: result.message };
        if (result.status === 'error') containerAppError = result.message;
      } else if (action === 'stop') {
        const result = await window.workingMemory.stopContainerApp(app.id);
        if (generation !== environmentGeneration) return;
        observeOpenAi('unreachable', error instanceof Error ? error.message : String(error));
        containerAppStatuses[app.id] = result.detail;
        if (result.status === 'error') containerAppError = result.message;
      } else if (action === 'open') {
        const status = await window.workingMemory.openContainerApp(app.id);
        if (generation !== environmentGeneration) return;
        containerAppStatuses[app.id] = status;
        if (status.error) containerAppError = status.error;
      } else {
        await refreshContainerApp(app);
      }
    } catch (error) {
      if (generation === environmentGeneration) containerAppError = error instanceof Error ? error.message : String(error);
    } finally {
      if (generation === environmentGeneration) busyContainerAppId = null;
    }
  }

  type DocumentPatch = TopicPatch & { status?: string };
  const documentSaves = createDocumentSaveQueue<DocumentPatch, DocumentVM>({
    delayMs: 350,
    save: (key, patch) => {
      const separator = key.indexOf(':');
      const kind = key.slice(0, separator);
      const identifier = key.slice(separator + 1);
      return kind === 'workstream'
        ? window.workingMemory.saveWorkstream(identifier, patch)
        : window.workingMemory.saveTopic(identifier, patch);
    },
    onPending: (key) => {
      documentSaveStates[key] = 'pending';
      if (key === selectedDocumentKey) saveState = 'pending';
    },
    onSaving: (key) => {
      documentSaveStates[key] = 'saving';
      documentSaveErrors[key] = '';
      if (key === selectedDocumentKey) {
        saveState = 'saving';
        documentError = '';
      }
    },
    onSaved: (key, document) => {
      replaceActive(document, key);
      documentSaveStates[key] = 'saved';
      documentSaveErrors[key] = '';
      if (key === selectedDocumentKey) saveState = 'saved';
      void refreshActive();
    },
    onError: (key, error) => {
      const message = error instanceof Error ? error.message : String(error);
      documentSaveStates[key] = 'error';
      documentSaveErrors[key] = message;
      if (key === selectedDocumentKey) {
        saveState = 'error';
        documentError = message;
      }
      void refreshActive();
    },
  });

  async function refreshBackendHealth(): Promise<void> {
    if (backendHealthChecking) return;
    backendHealthChecking = true;
    try {
      backendHealth = await window.workingMemory.getBackendHealth();
    } catch (error) {
      backendHealth = {
        state: 'unreachable',
        endpoint: selectedEnvironment?.mcpUrl ?? 'not selected',
        result: error instanceof Error ? error.message : String(error),
        observedAt: Date.now(),
        source: selectedEnvironment?.source ?? 'production',
      };
    } finally {
      backendHealthChecking = false;
    }
  }

  async function refreshOpenAiHealth(): Promise<void> {
    try {
      const result = await window.workingMemory.getOpenAiHealth();
      observeOpenAi(result.ok ? 'healthy' : 'degraded', result.message);
    } catch (error) {
      observeOpenAi('unreachable', error instanceof Error ? error.message : String(error));
    }
  }

  function observeOpenAi(state: 'healthy' | 'degraded' | 'unreachable', result: string): void {
    openAiHealth = { state, result, observedAt: Date.now() };
  }

  function statusTime(timestamp: number): string {
    return timestamp ? new Date(timestamp).toLocaleTimeString() : 'never';
  }
  const scopedRecentRuns = $derived(recentRunsForContext(chatRuns, currentChatContext));
  const scopedLatestRun = $derived(scopedRecentRuns[0] ?? null);
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
      activateHeaderTab('log');
      documentError = '';
    }
    if (result.journalId) await refreshJournal(result.journalId);
    void refreshActive();
  }

  function liveScope(context = currentChatContext): CommandJournalScopeRef {
    return context
      ? { kind: context.kind, id: context.identifier, title: context.title }
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

  async function refreshLatestHistory(initialize = false): Promise<void> {
    const generation = environmentGeneration;
    if (historyRequestGeneration === generation) return;
    historyRequestGeneration = generation;
    if (initialize) historyLoading = true;
    historyError = '';
    try {
      const historyPage = await window.workingMemory.getChatHistory({ limit: HISTORY_PAGE_SIZE });
      if (generation !== environmentGeneration) return;
      chatRuns = refreshLatestRuns(chatRuns, historyPage.journals);
      if (initialize) historyCursor = historyPage.nextCursor;
    } catch (error) {
      if (generation !== environmentGeneration) return;
      historyError = error instanceof Error ? error.message : String(error);
    } finally {
      if (historyRequestGeneration === generation) {
        historyRequestGeneration = null;
        if (initialize) historyLoading = false;
      }
    }
  }

  async function loadOlderHistory(): Promise<void> {
    const generation = environmentGeneration;
    if (!historyCursor || historyRequestGeneration === generation) return;
    historyRequestGeneration = generation;
    const previousHeight = conversationElement?.scrollHeight ?? 0;
    const previousTop = conversationElement?.scrollTop ?? 0;
    historyLoading = true;
    historyError = '';
    try {
      const historyPage = await window.workingMemory.getChatHistory({
        limit: HISTORY_PAGE_SIZE,
        cursor: historyCursor,
      });
      if (generation !== environmentGeneration) return;
      chatRuns = mergeHistoryRuns(chatRuns, historyPage.journals);
      historyCursor = historyPage.nextCursor;
      await tick();
      if (conversationElement) {
        conversationElement.scrollTop = previousTop + conversationElement.scrollHeight - previousHeight;
        conversationPinned = false;
      }
    } catch (error) {
      if (generation !== environmentGeneration) return;
      historyError = error instanceof Error ? error.message : String(error);
    } finally {
      if (historyRequestGeneration === generation) {
        historyRequestGeneration = null;
        historyLoading = false;
      }
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
    void refreshOpenAiHealth();
    void discoverEnvironments(true);
    void refreshActive();
    void refreshLatestHistory(true);
    void loadContainerApps();
    const stopListeningForDeepLinks = window.workingMemory.onOpenResource(
      (kind, identifier) => void openResource(kind, identifier),
    );
    void refreshBackendHealth();
    const historyPoll = window.setInterval(() => void refreshLatestHistory(), CHAT_HISTORY_POLL_INTERVAL_MS);
    const backendHealthPoll = window.setInterval(() => void refreshBackendHealth(), 30_000);
    return () => {
      stopListeningForDeepLinks();
      window.clearInterval(historyPoll);
      window.clearInterval(backendHealthPoll);
      window.removeEventListener('resize', handleResize);
      document.body.classList.remove('resizing-rails');
      clearPreviewAttention();
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
      documents = documents.map((document) =>
        document.kind === 'topic-backlog'
          ? { ...document, topics: panel.topicBacklog ?? [] }
          : document,
      );
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
    documentSaves.clear();
    documentSaveStates = {};
    documentSaveErrors = {};
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
    containerAppStatuses = reset.containerAppStatuses;
    containerAppError = '';
    activeHeaderTab = 'log';
    focusedHeaderTab = 'log';
    busyContainerAppId = reset.busyContainerAppId;
    conversationPinned = true;
    closeMentionCompletion();
  }

  async function switchEnvironment(mcpUrl: string): Promise<void> {
    environmentLoading = true;
    environmentError = '';
    try {
      await documentSaves.flushAll();
      environmentGeneration += 1;
      historyRequestGeneration = null;
      resetEnvironmentState();
      const state = await window.workingMemory.switchEnvironment(mcpUrl);
      applyEnvironmentState(state);
      input = readComposerDraft(localStorage, selectedEnvironment?.id);
      await reloadEnvironmentBoundData(refreshActive, () => refreshLatestHistory(true));
      await loadContainerApps();
      await refreshBackendHealth();
    } catch (error) {
      environmentError = error instanceof Error ? error.message : String(error);
    } finally {
      environmentLoading = false;
    }
  }

  function loadConfig(config: PublicConfig): void {
    endpoint = config.endpoint;
    credentialStorage = config.credentialStorage;
    modelProfiles = config.profiles.map((profile) => ({ ...profile, apiKey: '' }));
    modelRouting = { ...config.routing };
    humanName = config.humanName;
  }

  function addModelProfile(): void {
    const id = crypto.randomUUID();
    modelProfiles = [...modelProfiles, {
      id,
      name: `Model ${modelProfiles.length + 1}`,
      endpoint: endpoint || 'http://localhost:11434/v1',
      model: '',
      hasApiKey: false,
      apiKey: '',
    }];
  }

  function removeModelProfile(id: string): void {
    if (modelProfiles.length <= 1) return;
    const next = modelProfiles.filter((profile) => profile.id !== id);
    const fallback = next[0].id;
    modelProfiles = next;
    modelRouting = Object.fromEntries(
      Object.entries(modelRouting).map(([key, profileId]) => [key, profileId === id ? fallback : profileId]),
    ) as ModelRouting;
  }

  async function submitChat(
    message: string,
    context = currentChatContext,
    images: ChatPromptImage[] = [],
  ): Promise<string | null> {
    if (!message.trim() || busy || pendingConfirmation) return 'The chat request cannot be sent right now.';
    const runKey = crypto.randomUUID();
    chatRuns = [...chatRuns, createLiveRun(
      runKey,
      message,
      liveScope(context),
      Date.now(),
      images.map(({ attachment }) => attachment),
    )];
    scopePreviewExpanded = true;
    busy = true;
    const generation = environmentGeneration;
    try {
      const result = await window.workingMemory.sendChat(message, context, images);
      if (generation === environmentGeneration) {
        observeOpenAi(result.status === 'failed' ? 'degraded' : 'healthy', `Request ${result.status}.`);
        await applyChatResult(result, runKey);
        return result.status === 'failed' ? result.message : null;
      }
      return 'The Working Memory environment changed before the request completed.';
    } catch (error) {
      const message = `Unable to complete that request: ${error instanceof Error ? error.message : String(error)}`;
      if (generation === environmentGeneration) {
        chatRuns = chatRuns.map((run) => run.key === runKey
          ? { ...run, status: 'failed', assistantText: message }
          : run);
      }
      return message;
    } finally {
      if (generation === environmentGeneration) busy = false;
    }
  }

  async function send(): Promise<void> {
    const message = input.trim();
    if ((!message && composerImages.length === 0) || busy || pendingConfirmation || composerImageWorking) return;
    const context = currentChatContext;
    const images = [...composerImages];
    const promptImages = images;
    composerImageWorking = true;
    composerImageError = '';
    try {
      const modelImages = promptImages.map((image) => ({
        attachment: {
          id: image.attachment.id,
          filename: image.attachment.filename,
          mimeType: image.attachment.mimeType,
        },
      }));
      if (message || modelImages.length) {
        closeMentionCompletion();
        const submission = submitChat(
          message || 'Review the attached image.',
          context,
          modelImages,
        );
        input = '';
        writeComposerDraft(localStorage, selectedEnvironment?.id, '');
        clearComposerImages();
        await submission;
      }
    } catch (error) {
      composerImageError = error instanceof Error ? error.message : String(error);
    } finally {
      composerImageWorking = false;
    }
  }

  async function retryRun(run: ChatRun): Promise<void> {
    if (!isRetryableRun(run) || busy || pendingConfirmation) return;
    await submitChat(
      run.userText,
      chatContextForScope(run.scope),
      run.attachments.map((attachment) => ({
        attachment: {
          id: attachment.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
        },
      })),
    );
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
      if (generation === environmentGeneration) {
        observeOpenAi(result.status === 'failed' ? 'degraded' : 'healthy', `Request ${result.status}.`);
        await applyChatResult(result, runKey);
      }
    } catch (error) {
      if (generation !== environmentGeneration) return;
      chatRuns = chatRuns.map((run) => run.key === runKey || run.journalId === runKey
        ? { ...run, status: 'failed', assistantText: `Unable to resolve that action: ${error instanceof Error ? error.message : String(error)}` }
        : run);
    } finally {
      if (generation === environmentGeneration) busy = false;
    }
  }

  function modelProfileInput(profile: EditableModelProfile & { apiKey: string }): EditableModelProfile {
    return {
      id: profile.id,
      name: profile.name,
      endpoint: profile.endpoint,
      model: profile.model,
      hasApiKey: profile.hasApiKey,
      ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
    };
  }

  function settingsInput(): { profiles: EditableModelProfile[]; routing: ModelRouting; humanName: string } {
    const routing = {} as ModelRouting;
    for (const depth of AI_DEPTHS) {
      for (const speed of AI_SPEEDS) {
        routing[`${depth.id}:${speed}`] = modelRouting[`${depth.id}:${speed}`];
      }
    }
    return {
      profiles: modelProfiles.map(modelProfileInput),
      routing,
      humanName,
    };
  }

  async function saveSettings(): Promise<void> {
    if (saving || testingProfileId) return;
    saving = true;
    settingsStatus = 'Saving…';
    try {
      loadConfig(await window.workingMemory.saveConfig(settingsInput()));
      settingsStatus = 'Saved';
    } catch (error) {
      settingsStatus = error instanceof Error ? error.message : String(error);
    } finally {
      saving = false;
    }
  }

  async function testModelProfile(profile: EditableModelProfile & { apiKey: string }): Promise<void> {
    if (saving || testingProfileId) return;
    testingProfileId = profile.id;
    settingsStatus = `Testing ${profile.name || profile.model}…`;
    try {
      const result = await window.workingMemory.testModelProfile(modelProfileInput(profile));
      observeOpenAi(result.ok ? 'healthy' : 'degraded', result.message);
      settingsStatus = result.message;
    } catch (error) {
      settingsStatus = error instanceof Error ? error.message : String(error);
    } finally {
      testingProfileId = null;
    }
  }

  function openSettings(): void {
    const next = openDocumentTab(
      { tabs: documents, selectedKey: selectedDocumentKey },
      { kind: 'settings', id: 'desktop-settings', slug: null, title: 'Settings' },
    );
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
    restoreDocumentSaveStatus(next.selectedKey);
  }

  function replaceActive(document: DocumentVM, key = selectedDocumentKey): void {
    const next = key
      ? updateDocumentTab({ tabs: documents, selectedKey: selectedDocumentKey }, key, document)
      : replaceSelectedTab({ tabs: documents, selectedKey: selectedDocumentKey }, document);
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
  }

  function restoreDocumentSaveStatus(key: string | null): void {
    saveState = key ? (documentSaveStates[key] ?? 'idle') : 'idle';
    documentError = key ? (documentSaveErrors[key] ?? '') : '';
  }

  async function openResource(kind: DesktopResourceKind, identifier: string): Promise<void> {
    try {
      const document = await window.workingMemory.openResource(kind, identifier);
      const next = openDocumentTab({ tabs: documents, selectedKey: selectedDocumentKey }, document);
      documents = next.tabs;
      selectedDocumentKey = next.selectedKey;
      activateHeaderTab('log');
      restoreDocumentSaveStatus(next.selectedKey);
    } catch (error) {
      documentError = error instanceof Error ? error.message : String(error);
    }
  }

  async function startTopicCreation(
    workstream: string,
    workstreamTitle: string,
    parent?: { slug: string; title: string },
  ): Promise<void> {
    documentError = '';
    try {
      const topicTypes = await window.workingMemory.listTopicTypes();
      const draft: TopicCreateDraftVM = {
        kind: 'topic-create',
        id: crypto.randomUUID(),
        slug: null,
        title: '',
        body: '',
        topicType: topicTypes.find((topicType) => topicType.slug === 'topic')?.slug
          ?? topicTypes[0]?.slug
          ?? '',
        topicTypes,
        workstream,
        workstreamTitle,
        parent: parent?.slug ?? null,
        parentTitle: parent?.title ?? null,
      };
      const next = openDocumentTab({ tabs: documents, selectedKey: selectedDocumentKey }, draft);
      documents = next.tabs;
      selectedDocumentKey = next.selectedKey;
      activateHeaderTab('log');
    } catch (error) {
      documentError = error instanceof Error ? error.message : String(error);
    }
  }

  function openTopicBacklog(): void {
    const backlog: TopicBacklogVM = {
      kind: 'topic-backlog',
      id: 'open-topic-backlog',
      slug: null,
      title: 'Open topic backlog',
      topics: activePanel?.topicBacklog ?? [],
    };
    const next = openDocumentTab({ tabs: documents, selectedKey: selectedDocumentKey }, backlog);
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
    activateHeaderTab('log');
  }

  async function createTopic(draft: TopicCreateDraftVM): Promise<void> {
    const draftKey = documentTabKey(draft);
    const created = await window.workingMemory.createTopic({
      title: draft.title,
      body: draft.body,
      topicType: draft.topicType,
      workstream: draft.workstream,
      ...(draft.parent ? { parent: draft.parent } : {}),
    });
    const replaced = updateDocumentTab(
      { tabs: documents, selectedKey: selectedDocumentKey },
      draftKey,
      created,
    );
    documents = replaced.tabs;
    selectedDocumentKey = replaced.selectedKey;
    const workstreamKey = `workstream:${draft.workstream}`;
    if (documents.some((document) => documentTabKey(document) === workstreamKey)) {
      const refreshed = await window.workingMemory.openResource('workstream', draft.workstream);
      const updated = updateDocumentTab(
        { tabs: documents, selectedKey: selectedDocumentKey },
        workstreamKey,
        refreshed,
      );
      documents = updated.tabs;
      selectedDocumentKey = updated.selectedKey;
    }
    await refreshActive();
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

  async function transferActiveTopic(request: TopicTransferRequest): Promise<void> {
    activeLoading = true;
    activeError = '';
    let transferError = '';
    try {
      await documentSaves.flushAll();
      await window.workingMemory.invokeAction(
        request.targetWorkstream,
        'workingMemory.topic.transfer',
        [{
          topicSlug: request.slug,
          sourceWorkstream: request.sourceWorkstream,
          move: request.move,
        }],
      );
      const targets = topicTransferRefreshTargets(
        documents,
        request.sourceWorkstream,
        request.targetWorkstream,
      );
      const refreshed = await Promise.allSettled(targets.map(async (target) => ({
        key: target.key,
        document: await window.workingMemory.openResource(target.kind, target.identifier),
      })));
      let state = { tabs: documents, selectedKey: selectedDocumentKey };
      for (const result of refreshed) {
        if (result.status === 'fulfilled') {
          state = updateDocumentTab(state, result.value.key, result.value.document);
        }
      }
      documents = state.tabs;
      selectedDocumentKey = state.selectedKey;
      restoreDocumentSaveStatus(state.selectedKey);
      const failedRefreshes = refreshed.filter((result) => result.status === 'rejected').length;
      if (failedRefreshes > 0) {
        transferError = `Transfer completed, but ${failedRefreshes} open ${failedRefreshes === 1 ? 'tab' : 'tabs'} could not be refreshed.`;
      }
    } catch (error) {
      transferError = error instanceof Error ? error.message : String(error);
    } finally {
      activeLoading = false;
      await refreshActive();
      if (transferError) activeError = transferError;
    }
  }

  async function reorderActiveWorkstream(
    slug: string,
    targetSection: WorkstreamSection,
    targetIndex: number,
  ): Promise<void> {
    if (!activePanel) return;
    const order = { queue: [] as string[], progress: [] as string[], backlog: [] as string[] };
    for (const item of activePanel.items) {
      if (item.kind !== 'workstream-section') continue;
      order[item.section] = item.workstreams
        .map((workstream) => workstream.slug ?? '')
        .filter(Boolean);
    }
    const updates = planWorkstreamReorder(order, slug, targetSection, targetIndex);
    if (updates.length === 0) return;
    activeLoading = true;
    activeError = '';
    try {
      await window.workingMemory.reorderWorkstreams(updates);
    } catch (error) {
      activeError = error instanceof Error ? error.message : String(error);
    } finally {
      activeLoading = false;
      await refreshActive();
    }
  }

  function toggleActiveFocus(workstream: string, topic: string): void {
    if (!workstream || !topic) return;
    void mutateFromRail(workstream, () => window.workingMemory.togglePin(workstream, topic));
  }

  async function reparentActiveTopic(slug: string, parent: string | null): Promise<void> {
    activeError = '';
    try {
      await window.workingMemory.reparentTopic(slug, parent);
    } catch (error) {
      activeError = error instanceof Error ? error.message : String(error);
    } finally {
      await refreshActive();
      const refreshed = await Promise.allSettled(documents
        .filter((document) => document.kind === 'topic' && document.slug)
        .map(async (document) => ({
          key: documentTabKey(document),
          document: await window.workingMemory.openResource('topic', document.slug!),
        })));
      let state = { tabs: documents, selectedKey: selectedDocumentKey };
      for (const result of refreshed) {
        if (result.status === 'fulfilled') {
          state = updateDocumentTab(state, result.value.key, result.value.document);
        }
      }
      documents = state.tabs;
      selectedDocumentKey = state.selectedKey;
      restoreDocumentSaveStatus(state.selectedKey);
    }
  }

  function saveWorkstream(patch: { title?: string; status?: string }): void {
    const document = activeDocument;
    if (document?.kind !== 'workstream' || !document.slug) return;
    documentSaves.schedule(documentTabKey(document), patch);
  }

  function saveTopic(patch: TopicPatch): void {
    const document = activeDocument;
    if (document?.kind !== 'topic' || !document.slug) return;
    documentSaves.schedule(documentTabKey(document), patch);
  }

  async function attachImages(files: File[]): Promise<AttachmentRef[]> {
    return Promise.all(files.map(async (file) => window.workingMemory.uploadAttachment({
      name: file.name || 'image',
      type: file.type,
      data: await file.arrayBuffer(),
    })));
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
      activateHeaderTab('log');
      restoreDocumentSaveStatus(key);
    }
  }

  function activateHeaderTab(tab: HeaderTab): void {
    activeHeaderTab = tab;
    focusedHeaderTab = tab;
  }

  function focusHeaderTab(tab: HeaderTab): void {
    focusedHeaderTab = tab;
    void tick().then(() => document.getElementById(`desktop-tab-${tab}`)?.focus());
  }

  function handleHeaderTabKeydown(event: KeyboardEvent, tab: HeaderTab): void {
    const index = HEADER_TABS.indexOf(tab);
    let next: HeaderTab | undefined;
    if (event.key === 'ArrowLeft') next = HEADER_TABS[(index - 1 + HEADER_TABS.length) % HEADER_TABS.length];
    else if (event.key === 'ArrowRight') next = HEADER_TABS[(index + 1) % HEADER_TABS.length];
    else if (event.key === 'Home') next = HEADER_TABS[0];
    else if (event.key === 'End') next = HEADER_TABS[HEADER_TABS.length - 1];
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activateHeaderTab(tab);
      return;
    } else {
      return;
    }
    event.preventDefault();
    if (next) focusHeaderTab(next);
  }

  function applyDocumentTabs(next: { tabs: DocumentVM[]; selectedKey: string | null }): void {
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
    restoreDocumentSaveStatus(next.selectedKey);
  }

  function closeDocument(key: string): void {
    documentTabMenu = null;
    applyDocumentTabs(closeDocumentTab({ tabs: documents, selectedKey: selectedDocumentKey }, key));
  }

  async function openDocumentTabMenu(event: MouseEvent, key: string): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    selectDocument(key);
    documentTabMenu = { x: event.clientX, y: event.clientY, key };
    await tick();
    if (!documentTabMenu || !documentTabMenuElement) return;
    const bounds = documentTabMenuElement.getBoundingClientRect();
    documentTabMenu = {
      ...documentTabMenu,
      x: Math.max(4, Math.min(documentTabMenu.x, window.innerWidth - bounds.width - 4)),
      y: Math.max(4, Math.min(documentTabMenu.y, window.innerHeight - bounds.height - 4)),
    };
    documentTabMenuElement.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  function runDocumentTabMenuAction(action: 'close' | 'others' | 'right'): void {
    const key = documentTabMenu?.key;
    documentTabMenu = null;
    if (!key) return;
    const state = { tabs: documents, selectedKey: selectedDocumentKey };
    applyDocumentTabs(action === 'close'
      ? closeDocumentTab(state, key)
      : action === 'others'
        ? closeOtherDocumentTabs(state, key)
        : closeDocumentTabsToRight(state, key));
  }

  function navigateDocumentTabMenu(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      documentTabMenu = null;
      return;
    }
    if (!documentTabMenuElement || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...documentTabMenuElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function clearPreviewAttention(target = previewAttentionTarget): void {
    if (previewAttentionTimer !== undefined) window.clearTimeout(previewAttentionTimer);
    previewAttentionTimer = undefined;
    target?.classList.remove('preview-attention');
    if (target === previewAttentionTarget) previewAttentionTarget = null;
  }

  function restartPreviewAttention(target: HTMLElement): void {
    clearPreviewAttention();
    target.classList.remove('preview-attention');
    void target.offsetWidth;
    target.classList.add('preview-attention');
    previewAttentionTarget = target;
    const finish = () => clearPreviewAttention(target);
    target.addEventListener('animationend', finish, { once: true });
    previewAttentionTimer = window.setTimeout(finish, 1400);
  }

  function waitForScrollEnd(scroller: Element): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let fallbackTimer = 0;
      let idleTimer = 0;

      const finish = () => {
        if (settled) return;
        settled = true;
        scroller.removeEventListener('scroll', handleScroll);
        scroller.removeEventListener('scrollend', finish);
        window.clearTimeout(fallbackTimer);
        window.clearTimeout(idleTimer);
        resolve();
      };
      const handleScroll = () => {
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(finish, 120);
      };

      scroller.addEventListener('scroll', handleScroll, { passive: true });
      scroller.addEventListener('scrollend', finish, { once: true });
      fallbackTimer = window.setTimeout(finish, 2000);
    });
  }

  async function focusChatRun(run: ChatRun): Promise<void> {
    await focusChatRunTarget({
      activateLog: () => activateHeaderTab('log'),
      expandChatRail: () => (chatRailCollapsed = false),
      afterRender: tick,
      getTarget: () => document.getElementById(chatRunDomId(run)),
      waitForScrollEnd,
      restartAttention: restartPreviewAttention,
    });
  }
</script>

<svelte:window
  onclick={(event) => { documentTabMenu = null; handleDocumentClick(event); }}
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      documentTabMenu = null;
      if (selectedTool) selectedTool = null;
    }
  }}
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
          onRefresh={() => window.workingMemory.restartDesktop()}
          onSettings={openSettings}
          onCollapse={() => (activeRailCollapsed = true)}
          onOpen={openRoute}
          onToggleFocus={toggleActiveFocus}
          onAction={runActiveAction}
          onReorder={reorderActiveWorkstream}
          onTransferTopic={transferActiveTopic}
          onReparentTopic={(slug, parent) => void reparentActiveTopic(slug, parent)}
          onAddTopic={(workstream, parent) => {
            const card = activePanel?.items
              .filter((item) => item.kind === 'workstream-section')
              .flatMap((section) => section.workstreams)
              .find((candidate) => candidate.slug === workstream);
            void startTopicCreation(workstream, card?.label ?? workstream, parent);
          }}
          onOpenTopicBacklog={openTopicBacklog}
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
    {#if activeDocument}
      <div class="document-stage">
        <div class="document-tabs" role="tablist" aria-label="Open documents">
          {#each documents as document (documentTabKey(document))}
            {@const key = documentTabKey(document)}
            <div
              class="document-tab"
              class:selected={key === selectedDocumentKey}
              role="presentation"
              oncontextmenu={(event) => void openDocumentTabMenu(event, key)}
            >
              <button
                class="document-tab-select"
                role="tab"
                aria-selected={key === selectedDocumentKey}
                title={document.title}
                onclick={() => selectDocument(key)}
              >
                <span aria-hidden="true" class="codicon codicon-{document.kind === 'workstream' ? 'briefcase' : document.kind === 'topic' ? (document.typeMeta?.icon ?? 'symbol-misc') : document.kind === 'topic-create' ? 'add' : document.kind === 'topic-backlog' ? 'inbox' : document.kind === 'container-app' ? 'server-environment' : document.kind === 'settings' ? 'gear' : 'file'}"></span>
                <span>{document.kind === 'topic-create' && !document.title ? 'New Topic' : document.title}</span>
              </button>
              <button class="document-tab-close" title={`Close ${document.title}`} aria-label={`Close ${document.title}`} onclick={() => closeDocument(key)}>
                <span aria-hidden="true" class="codicon codicon-close"></span>
              </button>
            </div>
          {/each}
        </div>
        {#if documentTabMenu}
          {@const menuIndex = documents.findIndex((document) => documentTabKey(document) === documentTabMenu?.key)}
          <div
            bind:this={documentTabMenuElement}
            class="document-tab-menu"
            role="menu"
            aria-label="Document tab actions"
            tabindex="-1"
            style="left: {documentTabMenu.x}px; top: {documentTabMenu.y}px;"
            onclick={(event) => event.stopPropagation()}
            onkeydown={navigateDocumentTabMenu}
          >
            <button role="menuitem" onclick={() => runDocumentTabMenuAction('close')}>
              <span aria-hidden="true" class="codicon codicon-close"></span><span>Close</span>
            </button>
            <button role="menuitem" disabled={documents.length <= 1} onclick={() => runDocumentTabMenuAction('others')}>
              <span aria-hidden="true" class="codicon codicon-close-all"></span><span>Close Others</span>
            </button>
            <button role="menuitem" disabled={menuIndex < 0 || menuIndex === documents.length - 1} onclick={() => runDocumentTabMenuAction('right')}>
              <span aria-hidden="true" class="codicon codicon-arrow-right"></span><span>Close to the Right</span>
            </button>
          </div>
        {/if}
        <div
          class="document-host"
          class:topic-document={activeDocument?.kind === 'topic' || activeDocument?.kind === 'topic-create'}
          role="tabpanel"
          inert={environmentLoading}
        >
          <div class="document-toolbar">
          {#if documentError}<span class="document-error" role="alert">{documentError}</span>{/if}
          </div>
        {#if activeDocument?.kind === 'settings'}
          <SettingsView
            profiles={modelProfiles}
            routing={modelRouting}
            {humanName}
            {credentialStorage}
            {settingsStatus}
            {saving}
            {testingProfileId}
            onHumanName={(value) => (humanName = value)}
            onAddProfile={addModelProfile}
            onRemoveProfile={removeModelProfile}
            onTestProfile={testModelProfile}
            onSave={saveSettings}
          />
        {:else if activeDocument?.kind === 'container-app' && selectedContainerApp}
          <ContainerAppDetail
            app={selectedContainerApp}
            status={containerAppStatuses[selectedContainerApp.id]}
            busy={busyContainerAppId === selectedContainerApp.id}
            onAction={(action) => void runContainerAppAction(selectedContainerApp!, action)}
          />
        {:else if activeDocument?.kind === 'workstream'}
          <WorkstreamView
            ws={activeDocument}
            {saveState}
            onSave={saveWorkstream}
            onOpenTopic={(slug) => void openResource('topic', slug)}
            onAddTopic={(parent) => {
              const workstream = activeDocument as WorkstreamVM;
              if (workstream.slug) void startTopicCreation(workstream.slug, workstream.title, parent);
            }}
            onInvoke={invokeAction}
            onTogglePin={togglePin}
            onSetAlertStatus={setAlertStatus}
          />
        {:else if activeDocument?.kind === 'topic-create'}
          <TopicCreateView
            draft={activeDocument as TopicCreateDraftVM}
            attachmentBaseUrl={selectedEnvironment?.mcpUrl
              ? new URL(selectedEnvironment.mcpUrl).origin
              : ''}
            onAttachImages={attachImages}
            onCreate={() => createTopic(activeDocument as TopicCreateDraftVM)}
          />
        {:else if activeDocument?.kind === 'topic-backlog'}
          <TopicBacklogView
            backlog={activeDocument}
            onOpenTopic={(slug) => void openResource('topic', slug)}
          />
        {:else if activeDocument?.kind === 'topic'}
          <TopicView
            topic={activeDocument}
            {saveState}
            onSaveTopic={saveTopic}
            onOpenTopic={(slug) => void openResource('topic', slug)}
            onOpenWorkstream={(slug) => void openResource('workstream', slug)}
            onSetAlertStatus={setAlertStatus}
            attachmentBaseUrl={selectedEnvironment?.mcpUrl
              ? new URL(selectedEnvironment.mcpUrl).origin
              : ''}
            onAttachImages={attachImages}
          />
        {:else if activeDocument}
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
        <p>Open a workstream or topic from the Active rail, or ask through chat.</p>
      </section>
    {/if}
    </div>

      <section class="scope-preview" class:expanded={scopePreviewExpanded} aria-label="Recent messages">
        <div class="scope-preview-heading">
          <span>Recent messages</span>
          <button
            aria-expanded={scopePreviewExpanded}
            aria-label={scopePreviewExpanded ? 'Collapse recent response' : 'Expand recent response'}
            title={scopePreviewExpanded ? 'Collapse recent response' : 'Expand recent response'}
            onclick={() => (scopePreviewExpanded = !scopePreviewExpanded)}
          >
            <span
              aria-hidden="true"
              class="codicon codicon-chevron-{scopePreviewExpanded ? 'down' : 'up'}"
            ></span>
          </button>
        </div>
        {#if scopedRecentRuns.length === 0}
          <p>No messages for this scope.</p>
        {:else if !scopePreviewExpanded}
          {#each scopedRecentRuns as run (run.journalId ?? run.key)}
            <div class="scope-preview-row">
              <button class="scope-preview-main" onclick={() => void focusChatRun(run)} title="Show in history">
                <span>{run.userText}</span>
              </button>
              {#if isRetryableRun(run)}
                <button class="retry-button" disabled={busy || pendingConfirmation !== null} onclick={() => void retryRun(run)}>Retry</button>
              {/if}
            </div>
          {/each}
        {/if}
        {#if scopePreviewExpanded && scopedLatestRun}
          <article class="scope-preview-response" aria-label="Latest response" aria-live="polite">
            <section class="scope-preview-human">
              <span aria-hidden="true">{humanInitials(humanName)}</span>
              <p>{scopedLatestRun.userText}</p>
            </section>
            {#if scopedLatestRun.tools.length}
              <ol class="scope-preview-tools" aria-label="Latest tool activity">
                {#each scopedLatestRun.tools as tool (`preview:${tool.journalId}:${tool.sequence}`)}
                  <li class:failed={tool.status === 'failure'} class:cancelled={tool.status === 'cancelled'}>
                    <button onclick={() => void openToolDetail(tool)} aria-label={`Inspect ${tool.toolName}`}>
                      <span aria-hidden="true" class={`codicon codicon-${tool.mode === 'write' ? 'edit' : 'book'}`}></span>
                      <span>{tool.toolName}</span>
                      <small>{tool.status}</small>
                    </button>
                  </li>
                {/each}
              </ol>
            {:else if scopedLatestRun.progress?.length}
              <ul class="scope-preview-tools">
                {#each scopedLatestRun.progress as item}
                  <li class:failed={item.status === 'failed'}>{item.name}: {item.summary}</li>
                {/each}
              </ul>
            {/if}
            <section class="scope-preview-assistant" class:partial={!scopedLatestRun.assistantText}>
              <span>WM</span>
              {#if scopedLatestRun.assistantText}
                <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                <div>{@html renderMarkdown(scopedLatestRun.assistantText)}</div>
              {:else}
                <p>{assistantFallback(scopedLatestRun)}</p>
              {/if}
            </section>
          </article>
        {/if}
      </section>
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
        <form bind:this={composerElement} class="composer" onsubmit={(event) => { event.preventDefault(); closeMentionCompletion(); void send(); }}>
          <span id="mention-instructions" class="sr-only">Type at sign followed by a Container App name. Use up and down arrows to navigate, Enter or Tab to select, and Escape to dismiss.</span>
          {#if mentionOpen}
            <div class="mention-popup" id="container-app-mentions" role="listbox" aria-label="Container Apps">
              {#if mentionApps.length}
                {#each mentionApps as app, index (app.id)}
                  <button
                    type="button"
                    id={`container-app-mention-${app.id}`}
                    class="mention-option"
                    class:active={index === mentionActiveIndex}
                    role="option"
                    aria-selected={index === mentionActiveIndex}
                    tabindex="-1"
                    onmousedown={(event) => event.preventDefault()}
                    onclick={() => void selectMention(app)}
                  >
                    <span class="mention-option-label">
                      <strong>{app.displayName}</strong>
                      <code>@{app.id}</code>
                    </span>
                    <span class:mcp-ready={appAdvertisesMcp(app)} class="mention-mcp">
                      {appAdvertisesMcp(app) ? 'MCP ready' : 'No MCP endpoint'}
                    </span>
                  </button>
                {/each}
              {:else}
                <div class="mention-empty" role="status">No Container Apps match “{mentionToken?.query}”.</div>
              {/if}
            </div>
          {/if}
          {#if composerImages.length}
            <div class="composer-images" aria-label="Attached images">
              {#each composerImages as image, index (image.previewUrl)}
                <article class="composer-image">
                  <img src={image.previewUrl} alt={image.attachment.filename} />
                  <strong>{image.attachment.filename}</strong>
                  <button
                    type="button"
                    class="composer-image-remove"
                    aria-label={`Remove ${image.attachment.filename}`}
                    title="Remove image"
                    onclick={() => removeComposerImage(index)}
                  >
                    <span class="codicon codicon-close" aria-hidden="true"></span>
                  </button>
                </article>
              {/each}
            </div>
          {/if}
          {#if composerImageError}
            <p class="composer-image-error" role="alert">{composerImageError}</p>
          {/if}
          <textarea
            bind:this={composerTextarea}
            value={input}
            rows="3"
            aria-label="Message"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={mentionOpen}
            aria-controls={mentionOpen ? 'container-app-mentions' : undefined}
            aria-activedescendant={mentionOpen && mentionApps.length ? `container-app-mention-${mentionApps[mentionActiveIndex]?.id}` : undefined}
            aria-describedby="mention-instructions"
            placeholder="Write a command to interact with Working Memory"
            onpaste={handleComposerPaste}
            oninput={handleComposerInput}
            onclick={(event) => refreshMentionCompletion(event.currentTarget.value, event.currentTarget.selectionStart)}
            onkeyup={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
                refreshMentionCompletion(event.currentTarget.value, event.currentTarget.selectionStart);
              }
            }}
            onblur={handleComposerBlur}
            onkeydown={handleComposerKeydown}></textarea>
          <button
            type="button"
            class="camera-button"
            disabled={busy || composerImageWorking}
            title="Capture image"
            aria-label="Capture image"
            onclick={() => void openCamera()}
          >
            <span aria-hidden="true" class="codicon codicon-device-camera"></span>
          </button>
          <button
            class="send"
            disabled={busy || pendingConfirmation !== null || composerImageWorking || (!input.trim() && composerImages.length === 0)}
            title="Send"
            aria-label="Send"
          >
            <span aria-hidden="true" class="codicon codicon-send"></span>
          </button>
        </form>
      </div>
  </main>

  {#if cameraOpen}
    <div class="camera-backdrop" role="presentation">
      <div class="camera-dialog" role="dialog" aria-modal="true" aria-labelledby="camera-title">
        <header>
          <h2 id="camera-title">Capture image</h2>
          <button type="button" aria-label="Close camera" title="Close" onclick={closeCamera}>
            <span class="codicon codicon-close" aria-hidden="true"></span>
          </button>
        </header>
        {#if cameraCaptureUrl}
          <img class="camera-review" src={cameraCaptureUrl} alt="Captured camera preview" />
        {:else}
          <video bind:this={cameraVideo} class="camera-preview" autoplay muted playsinline></video>
        {/if}
        {#if cameraError}<p class="camera-error" role="alert">{cameraError}</p>{/if}
        <footer>
          {#if cameraCaptureUrl}
            <button type="button" onclick={() => void retakeCameraImage()}>Retake</button>
            <button type="button" class="camera-primary" onclick={() => void confirmCameraImage()}>Use photo</button>
          {:else}
            <button type="button" onclick={closeCamera}>Cancel</button>
            <button
              type="button"
              class="camera-primary"
              disabled={Boolean(cameraError)}
              onclick={captureCameraImage}
            >
              Take photo
            </button>
          {/if}
        </footer>
      </div>
    </div>
  {/if}

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
      <header class="desktop-header">
        <div class="mark">WM</div>
        <div class="desktop-header-tabs" role="tablist" aria-label="Desktop views">
          <button
            id="desktop-tab-log"
            role="tab"
            aria-selected={activeHeaderTab === 'log'}
            aria-controls="desktop-panel-log"
            tabindex={focusedHeaderTab === 'log' ? 0 : -1}
            onclick={() => activateHeaderTab('log')}
            onfocus={() => (focusedHeaderTab = 'log')}
            onkeydown={(event) => handleHeaderTabKeydown(event, 'log')}
          >Log</button>
          <button
            id="desktop-tab-container-apps"
            role="tab"
            aria-selected={activeHeaderTab === 'container-apps'}
            aria-controls="desktop-panel-container-apps"
            tabindex={focusedHeaderTab === 'container-apps' ? 0 : -1}
            onclick={() => activateHeaderTab('container-apps')}
            onfocus={() => (focusedHeaderTab = 'container-apps')}
            onkeydown={(event) => handleHeaderTabKeydown(event, 'container-apps')}
          >Container Apps</button>
        </div>
        <button
          class="icon-button"
          title="Collapse Chat rail"
          aria-label={chatRailCollapsed ? 'Expand Chat rail' : 'Collapse Chat rail'}
          onclick={() => (chatRailCollapsed = true)}
        ><span aria-hidden="true" class="codicon codicon-chevron-right"></span></button>
      </header>

      <div
        id="desktop-panel-log"
        class="chat-body"
        role="tabpanel"
        aria-labelledby="desktop-tab-log"
        hidden={activeHeaderTab !== 'log'}
        inert={activeHeaderTab !== 'log'}
      >
      <div class="conversation-shell">
      <div bind:this={conversationElement} class="conversation" aria-live="polite" onscroll={handleConversationScroll}>
      {#if historyCursor}
        <button class="load-older" disabled={historyLoading} onclick={() => void loadOlderHistory()}>
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
            {#if run.attachments.length}
              <div class="user-attachments" aria-label="Attached images">
                {#each run.attachments as attachment (attachment.id)}
                  <img
                    src={chatAttachmentUrl(attachment.id)}
                    alt={attachment.filename}
                    title={attachment.filename}
                  />
                {/each}
              </div>
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
          {#if isRetryableRun(run)}
            <div class="run-actions">
              <button class="retry-button" disabled={busy || pendingConfirmation !== null} onclick={() => void retryRun(run)}>Retry</button>
            </div>
          {/if}
        </article>
      {/each}
      {#if pendingConfirmation}
        <section class="confirmation" aria-label="Tool action confirmation">
          <strong>
            {pendingConfirmation.batchCount
              ? `Confirm ${pendingConfirmation.batchCount} changes?`
              : `Confirm ${pendingConfirmation.tool}?`}
          </strong>
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
      </div>

      <div
        id="desktop-panel-container-apps"
        class="container-apps-panel"
        role="tabpanel"
        aria-labelledby="desktop-tab-container-apps"
        hidden={activeHeaderTab !== 'container-apps'}
        inert={activeHeaderTab !== 'container-apps'}
      >
        <ContainerAppList
          apps={containerApps}
          statuses={containerAppStatuses}
          selectedId={selectedContainerAppId}
          onSelect={(app) => void openContainerAppDetail(app)}
        />
        {#if containerAppError}
          <p class="container-panel-error" role="alert">{containerAppError}</p>
        {/if}
      </div>
    {/if}
  </aside>

  <footer class="desktop-status-bar" title={`Built ${DESKTOP_BUILD_TIMESTAMP}`}>
    <span
      class="backend-status state-{backendHealthChecking ? 'checking' : backendHealth?.state ?? 'unknown'}"
      title="Endpoint: {backendHealth?.endpoint ?? selectedEnvironment?.mcpUrl ?? 'not selected'}&#10;Environment: {backendHealth?.source ?? selectedEnvironment?.source ?? 'unknown'}&#10;Result: {backendHealth?.result ?? 'Checking…'}&#10;Observed: {statusTime(backendHealth?.observedAt ?? 0)}"
    >
      <span class="status-dot"></span>
      Working Memory: {backendHealthChecking ? 'checking' : backendHealth?.state ?? 'unknown'}
    </span>
    <span
      class="backend-status state-{openAiHealth.state}"
      title="Endpoint: {endpoint || 'not configured'}&#10;Signal: startup connectivity test or normal backend usage&#10;Result: {openAiHealth.result}&#10;Observed: {statusTime(openAiHealth.observedAt)}"
    >
      <span class="status-dot"></span>
      OpenAI: {openAiHealth.state}
    </span>
    <span class="desktop-build-status">Built {desktopBuildLabel}</span>
  </footer>
</div>