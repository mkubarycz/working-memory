<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte';
  import ActiveRail from './ActiveRail.svelte';
  import BrainMark from './BrainMark.svelte';
  import UnreadBadge from './UnreadBadge.svelte';
  import RecentMessages from './RecentMessages.svelte';
  import ToolActivity from './ToolActivity.svelte';
  import ShareTopicDialog from './ShareTopicDialog.svelte';
  import MoveToNewWorkstreamDialog from './MoveToNewWorkstreamDialog.svelte';
  import type { TopicVM } from './documents/types';
  import ContainerAppDetail from './ContainerAppDetail.svelte';
  import ContainerAppList from './ContainerAppList.svelte';
  import WorkstreamView from './documents/WorkstreamView.svelte';
  import TopicView from './documents/TopicView.svelte';
  import TopicCreateView from './documents/TopicCreateView.svelte';
  import { createTopicFromDraft } from './topicCreation';
  import TopicBacklogView from './documents/TopicBacklogView.svelte';
  import SettingsView, { type SettingsTab } from './documents/SettingsView.svelte';
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
    ContainerAppResourceReference,
    ContainerAppStatus,
    DesktopEnvironment,
    DesktopEnvironmentState,
    DesktopResourceKind,
    EditableModelProfile,
    ModelRouting,
    DocumentChangeEvent,
    PublicConfig,
  } from '../shared/contracts';
  import {
    CONTAINER_APP_RESOURCE_MIME,
    composeContainerAppResourceMessage,
    containerAppResourceLabel,
    parseContainerAppResourceReference,
  } from './resourceDrag';
  import {
    containerAppDocument,
    containerAppIdForDocument,
    loadRegisteredContainerApps,
    type ContainerAppItem,
  } from './containerApps';
  import type { CommandJournalScopeRef, CommandJournalSummary } from '../../../shared/controlPlaneClient';
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
    createDocumentOpenGuard,
    documentTabKey,
    keepSelectedTabVisible,
    openDocumentTab,
    parseDocumentTabs,
    promoteDocumentTab,
    promoteOnDocumentInput,
    replaceSelectedTab,
    serializeDocumentTabs,
    updateDocumentTab,
    type DocumentTabsState,
  } from './documentTabs';
  import { collapseChatOnInteraction, chatRunDomId, loadScopedHistory, mergeScopedHistory, matchesChatContext, chatContextBusy, chatContextPending, chatContextKey } from './scopedChat';
  import { createDocumentChangeQueue, documentMatchesChange, documentRefreshTarget } from './documentChanges';
  import type { DocumentChanges } from '../../../shared/documentChanges';
  import { collectUnreadResponses, observeResponse, parseUnreadResponses, responseKey, unreadResponseCount, type UnreadResponse } from './chatUnread';
  import { focusChatRunTarget } from './chatRunFocus';
  import { RAIL_LAYOUT, parseStoredRailWidth, resizeRail, resolveRailWidths } from './railLayout';
  import { planWorkstreamReorder } from './workstreamReorder';
  import { topicTransferRefreshTargets, type TopicDragSource, type TopicTransferRequest } from './topicTransfer';
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
  let scopedHistory = $state<CommandJournalSummary[]>([]);
  let scopedHistoryLoading = $state(false);
  let scopedHistoryError = $state('');
  let scopedHistoryRevision = $state(0);
  let selectedTool = $state<SelectedTool | null>(null);
  let toolDetailRequest = 0;
  let toolInspectorElement = $state<HTMLElement | null>(null);
  let unreadResponses = $state<UnreadResponse[]>([]);
  let sharingTopic = $state<TopicVM | null>(null);
  let movingToNewWorkstream = $state<TopicDragSource | null>(null);
  let unreadEnvironment = $state<string | null>(null);
  let liveUpdateError = $state('');
  let historyInitialized = false;
  let activeChatContexts = $state<string[]>([]);
  const deferredDocumentRefreshes = new Set<string>();
  let documents = $state<DocumentVM[]>([]);
  let selectedDocumentKey = $state<string | null>(null);
  let previewDocumentKey = $state<string | null>(null);
  const documentOpens = createDocumentOpenGuard();
  const closedDuringRestore = new Set<string>();

  function documentTabsState(): DocumentTabsState {
    return { tabs: documents, selectedKey: selectedDocumentKey, previewKey: previewDocumentKey };
  }

  function promoteDocument(key = selectedDocumentKey): void {
    previewDocumentKey = promoteDocumentTab(documentTabsState(), key).previewKey ?? null;
  }
  let saveState = $state<SaveState>('idle');
  let documentError = $state('');
  let documentSaveStates = $state<Record<string, SaveState>>({});
  let documentSaveErrors = $state<Record<string, string>>({});
  let documentTabMenu = $state<{ x: number; y: number; key: string } | null>(null);
  let documentTabMenuElement = $state<HTMLDivElement | null>(null);
  let containerAppTabMenu = $state<{ x: number; y: number; key: string; appId: string } | null>(null);
  let containerAppTabMenuElement = $state<HTMLDivElement | null>(null);
  let containerAppViews = $state<Record<string, 'app' | 'info'>>({});
  let containerAppReloadVersions = $state<Record<string, number>>({});
  let endpoint = $state('');
  let credentialStorage = $state<PublicConfig['credentialStorage']>('secure');
  let modelProfiles = $state<Array<EditableModelProfile & { apiKey: string }>>([]);
  let modelRouting = $state<ModelRouting>({} as ModelRouting);
  let humanName = $state('Flesh Bag');
  let settingsStatus = $state('');
  let saving = $state(false);
  let testingProfileId = $state<string | null>(null);
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
  let composerResources = $state<ContainerAppResourceReference[]>([]);
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
  let documentTabsPersistenceReady = $state(false);
  const activeDocument = $derived(documents.find((document) => documentTabKey(document) === selectedDocumentKey) ?? null);
  const selectedContainerAppId = $derived(containerAppIdForDocument(activeDocument));
  const selectedContainerApp = $derived(containerApps.find((app) => app.id === selectedContainerAppId) ?? null);
  const currentChatContext = $derived(chatContextForDocument(activeDocument));
  const busy = $derived(contextBusy(currentChatContext));
  const pendingRun = $derived(chatContextPending(chatRuns, currentChatContext));
  const pendingConfirmation = $derived(pendingRun?.pendingConfirmation ?? null);

  function setChatRuns(next: ChatRun[], includeNew = historyInitialized): void {
    unreadResponses = collectUnreadResponses(unreadResponses, chatRuns, next, includeNew);
    chatRuns = next;
  }

  function markResponseViewed(key: string): void {
    unreadResponses = unreadResponses.filter((record) => record.key !== key);
  }

  function restoreUnreadResponses(): void {
    const id = selectedEnvironment?.id ?? null;
    unreadResponses = parseUnreadResponses(id ? localStorage.getItem(`working-memory.desktop.unread:${id}`) : null);
    unreadEnvironment = id;
  }

  $effect(() => {
    const id = selectedEnvironment?.id;
    if (id && unreadEnvironment === id) {
      localStorage.setItem(`working-memory.desktop.unread:${id}`, JSON.stringify(unreadResponses));
    }
  });

  function runBlocked(run: ChatRun): boolean {
    const context = chatContextForScope(run.scope);
    return contextBusy(context) || Boolean(chatContextPending(chatRuns, context));
  }

  function contextBusy(context: typeof currentChatContext): boolean {
    return activeChatContexts.includes(chatContextKey(context)) || chatContextBusy(chatRuns, context);
  }
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
    promoteDocument();
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
    promoteDocument();
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

  async function attachContainerAppResource(reference: ContainerAppResourceReference): Promise<void> {
    promoteDocument();
    const resourceKey = `${reference.appId}:${reference.resourceKind}:${reference.resourceId}`;
    const existingIndex = composerResources.findIndex((candidate) =>
      `${candidate.appId}:${candidate.resourceKind}:${candidate.resourceId}` === resourceKey);
    composerResources = existingIndex === -1
      ? [...composerResources, reference]
      : composerResources.map((candidate, index) => index === existingIndex ? reference : candidate);
    activeHeaderTab = 'log';
    focusedHeaderTab = 'log';
    chatRailCollapsed = false;
    await tick();
    composerTextarea?.focus();
    composerTextarea?.setSelectionRange(input.length, input.length);
  }

  function removeComposerResource(index: number): void {
    composerResources = composerResources.filter((_, current) => current !== index);
  }

  function handleComposerDragOver(event: DragEvent): void {
    if (event.dataTransfer?.types.includes(CONTAINER_APP_RESOURCE_MIME)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    }
  }

  function handleComposerDrop(event: DragEvent): void {
    const rawReference = event.dataTransfer?.getData(CONTAINER_APP_RESOURCE_MIME);
    if (!rawReference) return;
    const reference = parseContainerAppResourceReference(rawReference);
    if (!reference) return;
    event.preventDefault();
    void attachContainerAppResource(reference);
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
    promoteDocument();
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
    const generation = environmentGeneration;
    try {
      await loadRegisteredContainerApps(
        () => window.workingMemory.listContainerApps(),
        (id) => window.workingMemory.inspectContainerApp(id),
        () => environmentGeneration,
        (apps) => {
          containerApps = apps;
          for (const document of documents) {
            const id = containerAppIdForDocument(document);
            if (id && !apps.some((app) => app.id === id)) closeDocument(documentTabKey(document));
          }
        },
        (app, status) => {
          containerAppStatuses[app.id] = status;
          if (status.error) containerAppError = status.error;
        },
        (error) => {
          containerAppError = error instanceof Error ? error.message : String(error);
        },
      );
    } catch (error) {
      if (generation === environmentGeneration) {
        containerAppError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async function openContainerAppDetail(app: ContainerAppItem): Promise<void> {
    documentOpens.invalidate();
    const next = openDocumentTab(
      documentTabsState(),
      containerAppDocument(app),
      false,
    );
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
    previewDocumentKey = next.previewKey ?? null;
    containerAppViews[app.id] = app.embeddable ? 'app' : 'info';
    activateHeaderTab('container-apps');
    restoreDocumentSaveStatus(next.selectedKey);
    await refreshContainerApp(app);
  }

  function containerAppView(app: ContainerAppItem): 'app' | 'info' {
    return containerAppViews[app.id] ?? (app.embeddable ? 'app' : 'info');
  }

  async function openContainerAppTabMenu(
    event: MouseEvent,
    key: string,
    appId: string,
  ): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    selectDocument(key);
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    containerAppTabMenu = { x: bounds.right - 8, y: bounds.bottom + 2, key, appId };
    documentTabMenu = null;
    await tick();
    if (!containerAppTabMenu || !containerAppTabMenuElement) return;
    const menuBounds = containerAppTabMenuElement.getBoundingClientRect();
    containerAppTabMenu = {
      ...containerAppTabMenu,
      x: Math.max(4, Math.min(containerAppTabMenu.x - menuBounds.width, window.innerWidth - menuBounds.width - 4)),
      y: Math.max(4, Math.min(containerAppTabMenu.y, window.innerHeight - menuBounds.height - 4)),
    };
    containerAppTabMenuElement.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  function runContainerAppTabAction(
    app: ContainerAppItem,
    action: 'app' | 'info' | 'reload' | 'run' | 'open' | 'stop' | 'refresh',
  ): void {
    containerAppTabMenu = null;
    if (action === 'app' || action === 'info') {
      containerAppViews[app.id] = action;
      return;
    }
    if (action === 'reload') {
      containerAppReloadVersions[app.id] = (containerAppReloadVersions[app.id] ?? 0) + 1;
      containerAppViews[app.id] = 'app';
      return;
    }
    void runContainerAppAction(app, action);
  }

  function navigateContainerAppTabMenu(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      containerAppTabMenu = null;
      return;
    }
    if (!containerAppTabMenuElement || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...containerAppTabMenuElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
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
      if (deferredDocumentRefreshes.delete(key)) {
        void refreshOpenDocument(key).catch((error) => { liveUpdateError = String(error); });
      }
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

  const documentChanges = createDocumentChangeQueue(refreshChangedDocuments, (error) => {
    liveUpdateError = error instanceof Error ? error.message : String(error);
  });

  function handleDocumentChanges(event: DocumentChangeEvent): void {
    if (event.mcpUrl !== selectedEnvironment?.mcpUrl) return;
    if ('error' in event) {
      liveUpdateError = event.error;
      return;
    }
    liveUpdateError = '';
    documentChanges.enqueue(event.change);
  }

  async function startDocumentChanges(): Promise<void> {
    try {
      await window.workingMemory.startDocumentChanges();
    } catch (error) {
      liveUpdateError = error instanceof Error ? error.message : String(error);
    }
  }

  function documentIsDirty(key: string): boolean {
    return ['pending', 'saving', 'error'].includes(documentSaveStates[key] ?? '');
  }

  async function refreshOpenDocument(key: string): Promise<void> {
    const document = documents.find((candidate) => documentTabKey(candidate) === key);
    if (!document) return;
    const target = documentRefreshTarget(document);
    if (!target) return;
    if (documentIsDirty(key)) { deferredDocumentRefreshes.add(key); return; }
    const generation = environmentGeneration;
    const refreshed = await window.workingMemory.openResource(target.kind, target.identifier);
    if (generation !== environmentGeneration) return;
    if (documentIsDirty(key)) { deferredDocumentRefreshes.add(key); return; }
    const current = documents.find((candidate) => documentTabKey(candidate) === key);
    if (!current) return;
    if ('resourceVersion' in refreshed && 'resourceVersion' in current
      && refreshed.resourceVersion < current.resourceVersion) return;
    replaceActive(refreshed, key);
  }

  async function refreshChangedDocuments(change: DocumentChanges): Promise<void> {
    const generation = environmentGeneration;
    const journals = change.changes.filter((entry) => entry.kind.toLowerCase() === 'commandjournal');
    if (change.reset) {
      scopedHistoryRevision += 1;
      const activeJournals = chatRuns.filter((run) => run.journalId
        && ['running', 'submitting', 'awaiting_confirmation'].includes(run.status));
      await refreshLatestHistory();
      await Promise.all(activeJournals.map((run) => refreshJournal(run.journalId!)));
    }
    else await Promise.all(journals.map(async (entry) => {
      if (entry.deleted) {
        setChatRuns(chatRuns.filter((run) => run.journalId !== entry.id));
        scopedHistory = scopedHistory.filter((summary) => summary.id !== entry.id);
        scopedHistoryRevision += 1;
      }
      else await refreshJournal(entry.id);
    }));
    if (generation !== environmentGeneration) return;
    const related = change.changes.filter((entry) => entry.kind.toLowerCase() !== 'commandjournal');
    if (!change.reset && !related.length) return;
    for (const document of [...documents]) {
      const key = documentTabKey(document);
      const deleted = related.some((entry) => entry.deleted && documentMatchesChange(document, entry));
      if (!deleted) continue;
      if (documentIsDirty(key)) {
        deferredDocumentRefreshes.add(key);
        liveUpdateError = `“${document.title}” was deleted externally. Your unsaved draft has been kept.`;
      } else {
        applyDocumentTabs(closeDocumentTab(documentTabsState(), key));
      }
    }
    await Promise.all([
      refreshActive(),
      ...documents.map((document) => refreshOpenDocument(documentTabKey(document))),
      ...(change.reset || related.some((entry) => entry.kind.toLowerCase() === 'containerclaim') ? [loadContainerApps()] : []),
    ]);
  }

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
  const scopedContext = $derived(currentChatContext
    ? { ...currentChatContext, id: activeDocument?.id } : undefined);
  const scopedHistoryKey = $derived(`${selectedEnvironment?.id ?? ''}:${chatContextKey(scopedContext)}:${scopedContext?.id ?? ''}`);
  let loadedScopeKey = $state('');
  const scopedConversationRuns = $derived(mergeScopedHistory(chatRuns,
    loadedScopeKey === scopedHistoryKey ? scopedHistory : []));

  $effect(() => {
    const key = scopedHistoryKey;
    const revision = scopedHistoryRevision;
    const context = untrack(() => scopedContext);
    const generation = environmentGeneration;
    let cancelled = false;
    untrack(() => {
      loadedScopeKey = key;
      scopedHistory = [];
      scopedHistoryError = '';
      scopedHistoryLoading = !!context;
    });
    if (!context) return;
    const isCurrent = () => !cancelled && generation === environmentGeneration
      && key === scopedHistoryKey && revision === scopedHistoryRevision;
    void loadScopedHistory(context, (input) => window.workingMemory.getChatHistory(input), isCurrent,
      (summaries) => { scopedHistory = [...scopedHistory, ...summaries]; })
      .catch((error) => {
        if (isCurrent()) scopedHistoryError = error instanceof Error ? error.message : String(error);
      })
      .finally(() => { if (isCurrent()) scopedHistoryLoading = false; });
    return () => { cancelled = true; };
  });
  const resolvedRailWidths = $derived(resolveRailWidths(
    { active: activeRailWidth, chat: chatRailWidth },
    viewportWidth,
    { active: activeRailCollapsed, chat: chatRailCollapsed },
  ));

  const RAIL_STORAGE_KEYS = {
    active: 'working-memory.desktop.active-rail-width',
    chat: 'working-memory.desktop.chat-rail-width',
  } as const;
  const DOCUMENT_TABS_STORAGE_PREFIX = 'working-memory.desktop.document-tabs:v1:';
  const RESTORABLE_DOCUMENT_KINDS = new Set<DesktopResourceKind>([
    'workstream',
    'topic',
    'document',
    'alert',
    'topic-type',
  ]);

  function documentTabsStorageKey(): string | null {
    return selectedEnvironment?.id
      ? `${DOCUMENT_TABS_STORAGE_PREFIX}${selectedEnvironment.id}`
      : null;
  }

  $effect(() => {
    const storageKey = documentTabsStorageKey();
    const state = documentTabsState();
    if (!documentTabsPersistenceReady || !storageKey) return;
    localStorage.setItem(storageKey, serializeDocumentTabs(state));
  });

  async function applyChatResult(result: ChatResult, runKey: string): Promise<void> {
    const source = chatRuns.find((run) => run.key === runKey || run.journalId === runKey
      || (result.journalId && run.journalId === result.journalId));
    const foreground = source && matchesChatContext(source.scope, currentChatContext);
    setChatRuns(reconcileLiveRun(chatRuns, runKey, result));
    const document = result.document ?? result.workstream;
    if (document && foreground) {
      documentOpens.invalidate();
      const next = openDocumentTab(documentTabsState(), document, false);
      documents = next.tabs;
      selectedDocumentKey = next.selectedKey;
      previewDocumentKey = next.previewKey ?? null;
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
      if (journal) setChatRuns(mergeHistoryRuns(chatRuns, [journalToSummary(journal)]));
    } catch (error) {
      if (generation === environmentGeneration) {
        historyError = error instanceof Error ? error.message : String(error);
      }
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
      setChatRuns(refreshLatestRuns(chatRuns, historyPage.journals), !initialize && historyInitialized);
      historyInitialized = true;
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
      setChatRuns(mergeHistoryRuns(chatRuns, historyPage.journals), false);
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
    const generation = environmentGeneration;
    const request = ++toolDetailRequest;
    const isCurrent = () => generation === environmentGeneration && request === toolDetailRequest && selectedTool !== null;
    activateHeaderTab('log');
    chatRailCollapsed = false;
    selectedTool = { row, loading: true, error: '' };
    await tick();
    if (!isCurrent()) return;
    toolInspectorElement?.focus();
    try {
      const journal = await window.workingMemory.getChatJournal(row.journalId);
      if (!isCurrent()) return;
      const detail = journal ? toolDetail(journal, row.sequence) : undefined;
      selectedTool = detail
        ? { row, detail, loading: false, error: '' }
        : { row, loading: false, error: 'This tool event is no longer available.' };
    } catch (error) {
      if (!isCurrent()) return;
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
    void chatRuns;
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
    void initializeWorkspace();
    const stopListeningForDeepLinks = window.workingMemory.onOpenResource(
      (kind, identifier) => void openResource(kind, identifier),
    );
    const stopListeningForChanges = window.workingMemory.onDocumentChanges(handleDocumentChanges);
    const backendHealthPoll = window.setInterval(() => void refreshBackendHealth(), 30_000);
    return () => {
      stopListeningForDeepLinks();
      stopListeningForChanges();
      documentChanges.clear();
      window.clearInterval(backendHealthPoll);
      window.removeEventListener('resize', handleResize);
      document.body.classList.remove('resizing-rails');
      clearPreviewAttention();
    };
  });

  async function initializeWorkspace(): Promise<void> {
    // Discovery waits for the launch-time data-tier start, which may change the selected environment.
    await discoverEnvironments(true);
    restoreUnreadResponses();
    await Promise.all([refreshActive(), refreshLatestHistory(true), refreshBackendHealth(), loadContainerApps()]);
    await restoreDocumentTabs();
    await startDocumentChanges();
  }

  async function restoreDocumentTabs(): Promise<void> {
    closedDuringRestore.clear();
    const isCurrent = documentOpens.capture();
    const generation = environmentGeneration;
    documentTabsPersistenceReady = false;
    const storageKey = documentTabsStorageKey();
    const persisted = parseDocumentTabs(storageKey ? localStorage.getItem(storageKey) : null);
    if (!persisted) {
      documentTabsPersistenceReady = true;
      return;
    }
    const restored: DocumentVM[] = [];
    const restoreErrors: string[] = [];
    for (const reference of persisted.tabs) {
      try {
        let document: DocumentVM | null = null;
        if (reference.kind === 'container-app') {
          const app = containerApps.find((candidate) => candidate.id === reference.identifier);
          if (app) document = containerAppDocument(app);
        } else if (RESTORABLE_DOCUMENT_KINDS.has(reference.kind as DesktopResourceKind)) {
          document = await window.workingMemory.openResource(
            reference.kind as DesktopResourceKind,
            reference.identifier,
          );
        }
        if (document && !restored.some((candidate) =>
          documentTabKey(candidate) === documentTabKey(document!))) {
          restored.push(document);
        }
      } catch (error) {
        restoreErrors.push(
          `${reference.kind}:${reference.identifier}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (generation !== environmentGeneration) return;
    if (!isCurrent()) {
      const existingKeys = new Set(documents.map(documentTabKey));
      documents = [...documents, ...restored.filter((document) =>
        !existingKeys.has(documentTabKey(document)) && !closedDuringRestore.has(documentTabKey(document)))];
      documentTabsPersistenceReady = true;
      return;
    }
    documents = restored;
    previewDocumentKey = null;
    selectedDocumentKey = restored.some((document) =>
      documentTabKey(document) === persisted.selectedKey)
      ? persisted.selectedKey
      : restored.at(-1) ? documentTabKey(restored.at(-1)!) : null;
    const selectedAppId = containerAppIdForDocument(
      documents.find((document) => documentTabKey(document) === selectedDocumentKey) ?? null,
    );
    activeHeaderTab = selectedAppId ? 'container-apps' : 'log';
    focusedHeaderTab = activeHeaderTab;
    restoreDocumentSaveStatus(selectedDocumentKey);
    if (restoreErrors.length) {
      documentError = `Some tabs could not be restored: ${restoreErrors.join('; ')}`;
    }
    documentTabsPersistenceReady = true;
  }

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
    documentChanges.clear();
    sharingTopic = null;
    movingToNewWorkstream = null;
    deferredDocumentRefreshes.clear();
    unreadEnvironment = null;
    unreadResponses = [];
    liveUpdateError = '';
    historyInitialized = false;
    activeChatContexts = [];
    documentSaveStates = {};
    documentSaveErrors = {};
    input = reset.input;
    documents = reset.documents;
    selectedDocumentKey = null;
    previewDocumentKey = null;
    documentOpens.invalidate();
    saveState = reset.saveState;
    documentError = reset.documentError;
    chatRuns = reset.chatRuns;
    historyLoading = reset.historyLoading;
    historyError = reset.historyError;
    historyCursor = reset.historyCursor;
    scopedHistory = [];
    scopedHistoryError = '';
    scopedHistoryLoading = false;
    selectedTool = reset.selectedTool;
    activePanel = reset.activePanel;
    activeLoading = reset.activeLoading;
    activeError = reset.activeError;
    hasUnseenMessages = reset.hasUnseenMessages;
    containerAppStatuses = reset.containerAppStatuses;
    containerApps = [];
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
      documentTabsPersistenceReady = false;
      environmentGeneration += 1;
      historyRequestGeneration = null;
      resetEnvironmentState();
      const state = await window.workingMemory.switchEnvironment(mcpUrl);
      applyEnvironmentState(state);
      restoreUnreadResponses();
      input = readComposerDraft(localStorage, selectedEnvironment?.id);
      await reloadEnvironmentBoundData(refreshActive, () => refreshLatestHistory(true));
      await loadContainerApps();
      await restoreDocumentTabs();
      await refreshBackendHealth();
      await startDocumentChanges();
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
    promoteDocument();
    const id = crypto.randomUUID();
    modelProfiles = [...modelProfiles, {
      id,
      name: `Model ${modelProfiles.length + 1}`,
      provider: 'openai-compatible',
      endpoint: endpoint || 'http://localhost:11434/v1',
      model: '',
      hasApiKey: false,
      apiKey: '',
    }];
  }

  function removeModelProfile(id: string): void {
    if (modelProfiles.length <= 1) return;
    promoteDocument();
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
    if (!message.trim() || contextBusy(context) || chatContextPending(chatRuns, context)) {
      return 'This conversation already has a request or confirmation in progress.';
    }
    if (matchesChatContext(liveScope(context), currentChatContext)) promoteDocument();
    const runKey = crypto.randomUUID();
    const contextKey = chatContextKey(context);
    activeChatContexts = [...activeChatContexts, contextKey];
    chatRuns = [...chatRuns, createLiveRun(
      runKey,
      message,
      liveScope(context),
      Date.now(),
      images.map(({ attachment }) => attachment),
    )];
    scopePreviewExpanded = true;
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
        setChatRuns(chatRuns.map((run) => run.key === runKey
          ? { ...run, status: 'failed', assistantText: message, unpersistedResult: true }
          : run));
      }
      return message;
    } finally {
      if (generation === environmentGeneration) {
        activeChatContexts = activeChatContexts.filter((key) => key !== contextKey);
      }
    }
  }

  async function send(): Promise<void> {
    const message = composeContainerAppResourceMessage(input, composerResources);
    if ((!message && composerImages.length === 0) || busy || pendingConfirmation || composerImageWorking) return;
    const context = currentChatContext;
    const images = [...composerImages];
    const promptImages = images;
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
        composerResources = [];
        clearComposerImages();
        await submission;
      }
    } catch (error) {
      composerImageError = error instanceof Error ? error.message : String(error);
    }
  }

  async function retryRun(run: ChatRun): Promise<void> {
    if (!isRetryableRun(run) || runBlocked(run)) return;
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
    if (value !== input) promoteDocument();
    input = value;
    writeComposerDraft(localStorage, selectedEnvironment?.id, value);
  }

  async function resolveConfirmation(confirmed: boolean, run: ChatRun): Promise<void> {
    const pending = run.pendingConfirmation;
    const runKey = run.key;
    const context = chatContextForScope(run.scope);
    if (!pending || contextBusy(context)) return;
    const contextKey = chatContextKey(context);
    activeChatContexts = [...activeChatContexts, contextKey];
    setChatRuns(chatRuns.map((candidate) => candidate.key === runKey
      ? { ...candidate, status: 'running', pendingConfirmation: undefined, unpersistedResult: true } : candidate));
    const generation = environmentGeneration;
    try {
      const result = await window.workingMemory.resolveChatConfirmation(pending.id, confirmed, context);
      if (generation === environmentGeneration) {
        observeOpenAi(result.status === 'failed' ? 'degraded' : 'healthy', `Request ${result.status}.`);
        await applyChatResult(result, runKey);
      }
    } catch (error) {
      if (generation !== environmentGeneration) return;
      setChatRuns(chatRuns.map((run) => run.key === runKey || run.journalId === runKey
        ? { ...run, status: 'failed', assistantText: `Unable to resolve that action: ${error instanceof Error ? error.message : String(error)}`, unpersistedResult: true }
        : run));
    } finally {
      if (generation === environmentGeneration) {
        activeChatContexts = activeChatContexts.filter((key) => key !== contextKey);
      }
    }
  }

  function modelProfileInput(profile: EditableModelProfile & { apiKey: string }): EditableModelProfile {
    return {
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
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

  let settingsTab = $state<SettingsTab>('models');

  function openSettings(tab?: SettingsTab): void {
    documentOpens.invalidate();
    if (tab) settingsTab = tab;
    const next = openDocumentTab(
      documentTabsState(),
      { kind: 'settings', id: 'desktop-settings', slug: null, title: 'Settings' },
    );
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
    previewDocumentKey = next.previewKey ?? null;
    restoreDocumentSaveStatus(next.selectedKey);
  }

  function openInstances(): void {
    openSettings('instances');
  }

  async function makeInstanceCurrent(mcpUrl: string): Promise<void> {
    await switchEnvironment(mcpUrl);
    openInstances();
  }

  function replaceActive(document: DocumentVM, key = selectedDocumentKey): void {
    const next = key
      ? updateDocumentTab(documentTabsState(), key, document)
      : replaceSelectedTab(documentTabsState(), document);
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
    previewDocumentKey = next.previewKey ?? null;
  }

  function restoreDocumentSaveStatus(key: string | null): void {
    saveState = key ? (documentSaveStates[key] ?? 'idle') : 'idle';
    documentError = key ? (documentSaveErrors[key] ?? '') : '';
  }

  async function openResource(kind: DesktopResourceKind, identifier: string): Promise<void> {
    documentOpens.invalidate();
    const existing = documents.find((document) => documentTabKey(document) === `${kind}:${identifier}`);
    if (existing) {
      selectDocument(documentTabKey(existing));
      return;
    }
    const isCurrent = documentOpens.capture();
    const generation = environmentGeneration;
    try {
      const document = await window.workingMemory.openResource(kind, identifier);
      if (!isCurrent() || generation !== environmentGeneration) return;
      if (documents.some((tab) => documentTabKey(tab) === documentTabKey(document))) {
        selectDocument(documentTabKey(document));
        return;
      }
      const next = openDocumentTab(documentTabsState(), document);
      documents = next.tabs;
      selectedDocumentKey = next.selectedKey;
      previewDocumentKey = next.previewKey ?? null;
      activateHeaderTab('log');
      restoreDocumentSaveStatus(next.selectedKey);
    } catch (error) {
      if (!isCurrent() || generation !== environmentGeneration) return;
      documentError = error instanceof Error ? error.message : String(error);
    }
  }

  async function startTopicCreation(
    workstream: string,
    workstreamTitle: string,
    parent?: { slug: string; title: string },
    newWorkstream = false,
  ): Promise<void> {
    documentOpens.invalidate();
    const isCurrent = documentOpens.capture();
    const generation = environmentGeneration;
    documentError = '';
    try {
      const topicTypes = await window.workingMemory.listTopicTypes();
      if (!isCurrent() || generation !== environmentGeneration) return;
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
        ...(newWorkstream ? { newWorkstreamTitle: '' } : {}),
        parent: parent?.slug ?? null,
        parentTitle: parent?.title ?? null,
      };
      const next = openDocumentTab(documentTabsState(), draft, false);
      documents = next.tabs;
      selectedDocumentKey = next.selectedKey;
      previewDocumentKey = next.previewKey ?? null;
      activateHeaderTab('log');
    } catch (error) {
      if (!isCurrent() || generation !== environmentGeneration) return;
      documentError = error instanceof Error ? error.message : String(error);
    }
  }

  function openTopicBacklog(): void {
    documentOpens.invalidate();
    const backlog: TopicBacklogVM = {
      kind: 'topic-backlog',
      id: 'open-topic-backlog',
      slug: null,
      title: 'Open topic backlog',
      topics: activePanel?.topicBacklog ?? [],
    };
    const next = openDocumentTab(documentTabsState(), backlog);
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
    previewDocumentKey = next.previewKey ?? null;
    activateHeaderTab('log');
  }

  async function createTopic(draft: TopicCreateDraftVM): Promise<void> {
    const draftKey = documentTabKey(draft);
    promoteDocument(draftKey);
    const created = await createTopicFromDraft(draft, window.workingMemory);
    const replaced = updateDocumentTab(
      documentTabsState(),
      draftKey,
      created,
    );
    documents = replaced.tabs;
    selectedDocumentKey = replaced.selectedKey;
    previewDocumentKey = replaced.previewKey ?? null;
    const workstreamKey = `workstream:${draft.workstream}`;
    if (documents.some((document) => documentTabKey(document) === workstreamKey)) {
      const refreshed = await window.workingMemory.openResource('workstream', draft.workstream);
      const updated = updateDocumentTab(
        documentTabsState(),
        workstreamKey,
        refreshed,
      );
      documents = updated.tabs;
      selectedDocumentKey = updated.selectedKey;
      previewDocumentKey = updated.previewKey ?? null;
    }
    await refreshActive();
  }

  async function mutate(operation: () => Promise<DocumentVM>): Promise<void> {
    const targetKey = selectedDocumentKey;
    promoteDocument(targetKey);
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
    promoteDocument(`workstream:${workstream}`);
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

  async function transferActiveTopic(request: TopicTransferRequest): Promise<boolean> {
    activeLoading = true;
    activeError = '';
    let transferError = '';
    let transferred = false;
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
      transferred = true;
      const targets = topicTransferRefreshTargets(
        documents,
        request.sourceWorkstream,
        request.targetWorkstream,
      );
      const refreshed = await Promise.allSettled(targets.map(async (target) => ({
        key: target.key,
        document: await window.workingMemory.openResource(target.kind, target.identifier),
      })));
      let state = documentTabsState();
      for (const result of refreshed) {
        if (result.status === 'fulfilled') {
          state = updateDocumentTab(state, result.value.key, result.value.document);
        }
      }
      documents = state.tabs;
      selectedDocumentKey = state.selectedKey;
      previewDocumentKey = state.previewKey ?? null;
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
    return transferred;
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
      let state = documentTabsState();
      for (const result of refreshed) {
        if (result.status === 'fulfilled') {
          state = updateDocumentTab(state, result.value.key, result.value.document);
        }
      }
      documents = state.tabs;
      selectedDocumentKey = state.selectedKey;
      previewDocumentKey = state.previewKey ?? null;
      restoreDocumentSaveStatus(state.selectedKey);
    }
  }

  function saveWorkstream(document: DocumentVM | null, patch: { title?: string; status?: string }): void {
    if (document?.kind !== 'workstream' || !document.slug) return;
    promoteDocument(documentTabKey(document));
    documentSaves.schedule(documentTabKey(document), patch);
  }

  function saveTopic(document: DocumentVM | null, patch: TopicPatch): void {
    if (document?.kind !== 'topic' || !document.slug) return;
    promoteDocument(documentTabKey(document));
    documentSaves.schedule(documentTabKey(document), patch);
  }

  async function attachImages(files: File[]): Promise<AttachmentRef[]> {
    if (files.length) promoteDocument();
    const generation = environmentGeneration;
    const attachments = await Promise.all(files.map(async (file) => {
      const data = await file.arrayBuffer();
      if (generation !== environmentGeneration) throw new Error('The Working Memory environment changed during attachment upload.');
      return window.workingMemory.uploadAttachment({
        name: file.name || 'image',
        type: file.type,
        data,
      });
    }));
    if (generation !== environmentGeneration) throw new Error('The Working Memory environment changed during attachment upload.');
    return attachments;
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
      documentOpens.invalidate();
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

  function applyDocumentTabs(next: DocumentTabsState): void {
    documents = next.tabs;
    selectedDocumentKey = next.selectedKey;
    previewDocumentKey = next.previewKey ?? null;
    restoreDocumentSaveStatus(next.selectedKey);
  }

  function closeDocument(key: string): void {
    documentOpens.invalidate();
    if (!documentTabsPersistenceReady) closedDuringRestore.add(key);
    documentTabMenu = null;
    applyDocumentTabs(closeDocumentTab(documentTabsState(), key));
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
    documentOpens.invalidate();
    const state = documentTabsState();
    const next = action === 'close'
      ? closeDocumentTab(state, key)
      : action === 'others'
        ? closeOtherDocumentTabs(state, key)
        : closeDocumentTabsToRight(state, key);
    if (!documentTabsPersistenceReady) {
      for (const document of state.tabs) {
        const documentKey = documentTabKey(document);
        if (!next.tabs.some((tab) => documentTabKey(tab) === documentKey)) closedDuringRestore.add(documentKey);
      }
    }
    applyDocumentTabs(next);
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
    if (!chatRuns.some((candidate) => (candidate.journalId ?? candidate.key) === (run.journalId ?? run.key))) {
      setChatRuns([...chatRuns, run].sort((left, right) => left.startedAt - right.startedAt
        || (left.journalId ?? left.key).localeCompare(right.journalId ?? right.key)), false);
    }
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
  onclick={(event) => { documentTabMenu = null; containerAppTabMenu = null; handleDocumentClick(event); }}
  onkeydown={(event) => {
    if (event.key === 'Escape') {
      documentTabMenu = null;
      containerAppTabMenu = null;
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
  <aside class="active-rail" use:collapseChatOnInteraction={() => (scopePreviewExpanded = false)}>
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
          {unreadResponses}
          {environments}
          {selectedEnvironment}
          {environmentLoading}
          {environmentError}
          data={activePanel}
          loading={activeLoading}
          error={activeError}
          onDiscoverEnvironments={discoverEnvironments}
          onSwitchEnvironment={switchEnvironment}
          onManageInstances={openInstances}
          onRefresh={() => window.workingMemory.restartDesktop()}
          onSettings={() => openSettings()}
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
          onAddWorkstream={() => void startTopicCreation('', '', undefined, true)}
          onMoveToNewWorkstream={(source) => { movingToNewWorkstream = source; }}
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
    {#if liveUpdateError}
      <div class="document-error live-update-error" role="alert">Live updates: {liveUpdateError}
        <button onclick={() => void startDocumentChanges()}>Retry</button>
      </div>
    {/if}
    <div class="stage-content" use:collapseChatOnInteraction={() => (scopePreviewExpanded = false)}>
    {#if activeDocument}
      <div class="document-stage">
        <div class="document-tabs" role="tablist" aria-label="Open documents">
          {#each documents as document (documentTabKey(document))}
            {@const key = documentTabKey(document)}
            {@const tabApp = document.kind === 'container-app'
              ? containerApps.find((app) => app.id === (document.slug ?? document.id))
              : undefined}
            {@const tabAppStatus = tabApp ? containerAppStatuses[tabApp.id] : undefined}
            <div
              class="document-tab"
              use:keepSelectedTabVisible={key === selectedDocumentKey}
              class:selected={key === selectedDocumentKey}
              class:preview={key === previewDocumentKey}
              role="presentation"
              oncontextmenu={(event) => void openDocumentTabMenu(event, key)}
            >
              <button
                class="document-tab-select"
                role="tab"
                aria-selected={key === selectedDocumentKey}
                title={key === previewDocumentKey ? `${document.title} — Preview (double-click to keep open)` : document.title}
                onclick={() => selectDocument(key)}
                ondblclick={() => promoteDocument(key)}
              >
                <span aria-hidden="true" class="codicon codicon-{document.kind === 'workstream' ? 'briefcase' : document.kind === 'topic' ? (document.typeMeta?.icon ?? 'symbol-misc') : document.kind === 'topic-create' ? 'add' : document.kind === 'topic-backlog' ? 'inbox' : document.kind === 'container-app' ? 'server-environment' : document.kind === 'settings' ? 'gear' : 'file'}"></span>
                {#if tabApp}
                  <span
                    class="container-app-tab-health"
                    class:healthy={tabAppStatus?.ready}
                    class:unhealthy={tabAppStatus !== undefined && !tabAppStatus.ready}
                    title={tabAppStatus?.ready ? 'Healthy' : tabAppStatus?.state ?? 'Loading'}
                    aria-label={tabAppStatus?.ready ? 'Healthy' : tabAppStatus?.state ?? 'Loading'}
                  ></span>
                {/if}
                <span class="document-tab-label">{document.kind === 'topic-create' && !document.title ? (document.newWorkstreamTitle !== undefined ? 'New Workstream' : 'New Topic') : document.title}</span>
                {#if unreadResponseCount(unreadResponses, document.kind, document.slug, 'id' in document ? document.id : undefined) > 0}
                  <span class="tab-unread-dot" title="Unread response" aria-label="Unread response"></span>
                {/if}
              </button>
              {#if tabApp}
                {#if tabApp.embeddable}
                  <button
                    class="container-app-tab-refresh"
                    disabled={!tabAppStatus?.ready}
                    title={`Refresh ${tabApp.displayName}`}
                    aria-label={`Refresh ${tabApp.displayName}`}
                    onclick={(event) => {
                      event.stopPropagation();
                      selectDocument(key);
                      runContainerAppTabAction(tabApp, 'reload');
                    }}
                  >
                    <span aria-hidden="true" class="codicon codicon-refresh"></span>
                  </button>
                {/if}
                <button
                  class="container-app-tab-gear"
                  title={`${tabApp.displayName} actions`}
                  aria-label={`${tabApp.displayName} actions`}
                  onclick={(event) => void openContainerAppTabMenu(event, key, tabApp.id)}
                >
                  <span aria-hidden="true" class="codicon codicon-settings-gear"></span>
                </button>
              {/if}
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
        {#if containerAppTabMenu}
          {@const menuApp = containerApps.find((app) => app.id === containerAppTabMenu?.appId)}
          {@const menuStatus = menuApp ? containerAppStatuses[menuApp.id] : undefined}
          {#if menuApp}
            <div
              bind:this={containerAppTabMenuElement}
              class="document-tab-menu container-app-tab-menu"
              role="menu"
              aria-label={`${menuApp.displayName} actions`}
              tabindex="-1"
              style="left: {containerAppTabMenu.x}px; top: {containerAppTabMenu.y}px;"
              onclick={(event) => event.stopPropagation()}
              onkeydown={navigateContainerAppTabMenu}
            >
              {#if menuApp.embeddable}
                <button role="menuitem" onclick={() => runContainerAppTabAction(menuApp, containerAppView(menuApp) === 'app' ? 'info' : 'app')}>
                  <span aria-hidden="true" class="codicon codicon-{containerAppView(menuApp) === 'app' ? 'info' : 'open-preview'}"></span>
                  <span>{containerAppView(menuApp) === 'app' ? 'App Info' : 'Show App'}</span>
                </button>
              {/if}
              <button role="menuitem" disabled={busyContainerAppId !== null} onclick={() => runContainerAppTabAction(menuApp, 'run')}>
                <span aria-hidden="true" class="codicon codicon-play"></span><span>Run</span>
              </button>
              {#if menuApp.embeddable}
                <button role="menuitem" disabled={!menuStatus?.ready} onclick={() => runContainerAppTabAction(menuApp, 'reload')}>
                  <span aria-hidden="true" class="codicon codicon-refresh"></span><span>Reload App</span>
                </button>
              {/if}
              <button role="menuitem" disabled={!menuStatus?.ready} onclick={() => runContainerAppTabAction(menuApp, 'open')}>
                <span aria-hidden="true" class="codicon codicon-link-external"></span><span>Open Externally</span>
              </button>
              <button role="menuitem" disabled={busyContainerAppId !== null} onclick={() => runContainerAppTabAction(menuApp, 'refresh')}>
                <span aria-hidden="true" class="codicon codicon-sync"></span><span>Refresh Status</span>
              </button>
              <button role="menuitem" disabled={busyContainerAppId !== null} onclick={() => runContainerAppTabAction(menuApp, 'stop')}>
                <span aria-hidden="true" class="codicon codicon-debug-stop"></span><span>Stop</span>
              </button>
            </div>
          {/if}
        {/if}
        <div
          class="document-host"
          use:promoteOnDocumentInput={() => promoteDocument()}
          class:container-app-host={activeDocument?.kind === 'container-app'}
          class:topic-document={activeDocument?.kind === 'topic' || activeDocument?.kind === 'topic-create'}
          class:settings-host={activeDocument?.kind === 'settings'}
          role="tabpanel"
          inert={environmentLoading}
        >
          <div class="document-toolbar">
          {#if documentError}<span class="document-error" role="alert">{documentError}</span>{/if}
          </div>
        {#key selectedDocumentKey}
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
            bind:tab={settingsTab}
            selectedMcpUrl={selectedEnvironment?.mcpUrl ?? null}
            onMakeCurrent={makeInstanceCurrent}
            onInstancesChanged={() => discoverEnvironments()}
          />
        {:else if activeDocument?.kind === 'container-app' && selectedContainerApp}
          <ContainerAppDetail
            app={selectedContainerApp}
            status={containerAppStatuses[selectedContainerApp.id]}
            view={containerAppView(selectedContainerApp)}
            reloadVersion={containerAppReloadVersions[selectedContainerApp.id] ?? 0}
            onAttachResource={(reference) => void attachContainerAppResource(reference)}
          />
        {:else if activeDocument?.kind === 'workstream'}
          <WorkstreamView
            {unreadResponses}
            ws={activeDocument}
            {saveState}
            onSave={saveWorkstream.bind(null, activeDocument)}
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
            onCreate={createTopic.bind(null, activeDocument as TopicCreateDraftVM)}
          />
        {:else if activeDocument?.kind === 'topic-backlog'}
          <TopicBacklogView
            {unreadResponses}
            backlog={activeDocument}
            onOpenTopic={(slug) => void openResource('topic', slug)}
          />
        {:else if activeDocument?.kind === 'topic'}
          <TopicView
            {unreadResponses}
            topic={activeDocument}
            onShare={(topic) => { sharingTopic = topic; }}
            {saveState}
            onSaveTopic={saveTopic.bind(null, activeDocument)}
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
        {/key}
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

      <RecentMessages
        runs={scopedConversationRuns}
        context={scopedContext}
        bind:expanded={scopePreviewExpanded}
        loading={scopedHistoryLoading}
        error={scopedHistoryError}
        {humanName}
        {unreadResponses}
        onViewed={markResponseViewed}
        onFocus={(run) => void focusChatRun(run)}
        onRetry={(run) => void retryRun(run)}
        {runBlocked}
        onInspect={(tool) => void openToolDetail(tool)}
        onOpen={(target) => void openResource(target.kind, target.identifier)}
        attachmentUrl={chatAttachmentUrl}
        {assistantFallback}
        onReload={() => { scopedHistoryRevision += 1; }}
        onResolve={(confirmed, run) => void resolveConfirmation(confirmed, run)}
      />
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
        <form
          bind:this={composerElement}
          class="composer"
          ondragover={handleComposerDragOver}
          ondrop={handleComposerDrop}
          onsubmit={(event) => { event.preventDefault(); closeMentionCompletion(); void send(); }}
        >
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
          {#if composerResources.length}
            <div class="composer-resources" aria-label="Attached app resources">
              {#each composerResources as resource, index (`${resource.appId}:${resource.resourceKind}:${resource.resourceId}`)}
                <article class="composer-resource">
                  <span class="codicon codicon-link" aria-hidden="true"></span>
                  <a href={resource.deepLink} title={containerAppResourceLabel(resource)}>
                    {containerAppResourceLabel(resource)}
                  </a>
                  <small>@{resource.appId} · {resource.resourceKind}</small>
                  <button
                    type="button"
                    class="composer-resource-remove"
                    aria-label={`Remove ${resource.title}`}
                    title="Remove resource"
                    onclick={() => removeComposerResource(index)}
                  >
                    <span class="codicon codicon-close" aria-hidden="true"></span>
                  </button>
                </article>
              {/each}
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
            disabled={busy || pendingConfirmation !== null || composerImageWorking || (!input.trim() && composerImages.length === 0 && composerResources.length === 0)}
            title="Send"
            aria-label="Send"
          >
            <span aria-hidden="true" class="codicon codicon-send"></span>
          </button>
        </form>
      </div>
    {#if sharingTopic}
      <ShareTopicDialog topic={sharingTopic} beforeShare={() => documentSaves.flushAll()} onClose={() => { sharingTopic = null; }} />
    {/if}
    {#if movingToNewWorkstream}
      <MoveToNewWorkstreamDialog
        source={movingToNewWorkstream}
        beforeMove={() => documentSaves.flushAll()}
        onMove={async (request) => {
          if (!await transferActiveTopic(request)) throw new Error(activeError || 'The topic could not be moved.');
        }}
        onClose={() => { movingToNewWorkstream = null; }}
      />
    {/if}
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
        <BrainMark />
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
          <header class="timeline-command">
            <span class="timeline-dot" aria-hidden="true"></span>
            <time datetime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleString()}</time>
            <span class="timeline-state">{run.status.replaceAll('_', ' ')}</span>
            <UnreadBadge count={unreadResponses.some((record) => record.key === responseKey(run)) ? 1 : 0} />
          </header>
          <div class="timeline-details">
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
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div class="user-markdown">{@html renderMarkdown(run.userText)}</div>
          </section>

          <ToolActivity {run}
            onInspect={(tool) => void openToolDetail(tool)}
            onOpen={(target) => void openResource(target.kind, target.identifier)} />

          <section class="assistant-entry" class:partial={!run.assistantText}
            use:observeResponse={{ key: responseKey(run), enabled: unreadResponses.some((record) => record.key === responseKey(run)), onViewed: markResponseViewed }}>
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
              <button class="retry-button" disabled={runBlocked(run)} onclick={() => void retryRun(run)}>Retry</button>
            </div>
          {/if}
      {#if run.status === 'awaiting_confirmation' && run.pendingConfirmation}
        {@const pendingConfirmation = run.pendingConfirmation}
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
            <button class="confirm" onclick={() => void resolveConfirmation(true, run)}>Confirm</button>
            <button class="cancel" onclick={() => void resolveConfirmation(false, run)}>Cancel</button>
          </div>
        </section>
      {/if}
          </div>
        </article>
      {/each}
      {#if chatRuns.some((run) => run.status === 'running' || run.status === 'submitting')}
        <div class="thinking">Queries in progress…</div>
      {/if}
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
      title="Provider: {modelProfiles.find((profile) => profile.id === modelRouting['complex:medium'])?.provider === 'copilot' ? 'Local GitHub Copilot' : endpoint || 'not configured'}&#10;Signal: startup connectivity test or normal backend usage&#10;Result: {openAiHealth.result}&#10;Observed: {statusTime(openAiHealth.observedAt)}"
    >
      <span class="status-dot"></span>
      AI: {openAiHealth.state}
    </span>
    <span class="desktop-build-status">Built {desktopBuildLabel}</span>
  </footer>
</div>