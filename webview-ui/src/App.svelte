<script lang="ts">
  import { onMount } from 'svelte';
  import { createVsCodeTransport } from './lib/transport';
  import type { DocumentVM, SaveState, TopicPatch } from './lib/types';
  import { createPendingPatch } from './lib/pendingPatch';
  import { resolveView } from './lib/viewRegistry';
  import WorkstreamView from './lib/WorkstreamView.svelte';
  import TopicView from './lib/TopicView.svelte';
  import DocumentView from './lib/DocumentView.svelte';

  const transport = createVsCodeTransport();

  let doc = $state<DocumentVM | null>(null);
  let error = $state<string | null>(null);
  let saveState = $state<SaveState>('idle');
  // Non-terminal startup state: the control plane isn't connected yet. Distinct
  // from `error` so a reload race shows "connecting…" and self-heals (Bug B).
  let connecting = $state<boolean>(false);
  // A newer server version arrived while we hold unsaved edits — offer a reload
  // instead of silently stomping the user's work (Bug A).
  let staleReload = $state<boolean>(false);

  // One accumulator + ONE flush timer shared across all fields. Editing title
  // then status inside the debounce window merges into a single patch, so the
  // whole thing persists in one write and nothing is dropped.
  const pending = createPendingPatch<TopicPatch>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  // Last pending-state reported to the host, so we only post on transitions.
  let lastReportedPending = false;

  const DEBOUNCE_MS = 400;

  // Tell the host whether we hold un-flushed edits so its external-refresh
  // decision won't stomp in-progress work (posts only on change).
  function reportEditState(): void {
    const hasPending = !pending.isEmpty();
    if (hasPending !== lastReportedPending) {
      lastReportedPending = hasPending;
      transport.post({ type: 'editState', hasPendingEdits: hasPending });
    }
  }

  onMount(() => {
    const unsubscribe = transport.subscribe((msg) => {
      if (msg.type === 'document') {
        // Echo-stomp guard: while the user has un-flushed edits pending, ignore
        // the document echo so a stale VM can't clobber fields being typed. A
        // clean load (pending empty — e.g. initial render) always applies.
        if (pending.isEmpty()) {
          doc = msg.data;
          error = null;
          connecting = false;
          staleReload = false;
        }
      } else if (msg.type === 'saved') {
        error = null;
        connecting = false;
        // Green only when the write is fully settled — a new edit queued after
        // the flush keeps us amber until its own confirmation arrives.
        if (pending.isEmpty()) {
          saveState = 'saved';
        }
      } else if (msg.type === 'error') {
        error = msg.message;
        connecting = false;
        saveState = 'error';
      } else if (msg.type === 'connecting') {
        // Non-terminal: waiting for the control plane. A later refresh heals it.
        connecting = true;
        error = null;
      } else if (msg.type === 'staleReload') {
        staleReload = true;
      }
    });
    transport.post({ type: 'ready' });
    return unsubscribe;
  });

  // Debounced autosave — no dirty state, no save prompt. Each edit merges into
  // the pending patch and (re)arms ONE timer; the flush posts the whole patch.
  function queueEdit(fields: TopicPatch): void {
    pending.merge(fields);
    reportEditState();
    saveState = 'pending';
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function flush(): void {
    const patch = pending.flush();
    reportEditState();
    if (!patch) {
      return;
    }
    saveState = 'saving';
    if (doc?.kind === 'workstream') {
      transport.post({ type: 'save', patch });
    } else if (doc?.kind === 'topic') {
      transport.post({ type: 'saveTopic', patch });
    }
  }

  // Reload banner: discard local edits and take the server version. Clearing
  // pending BEFORE asking the host to re-push means the echo-stomp guard lets
  // the fresh document through.
  function discardAndReload(): void {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    pending.flush();
    reportEditState();
    staleReload = false;
    saveState = 'idle';
    transport.post({ type: 'discardAndReload' });
  }

  function saveWorkstream(patch: { title?: string; status?: string }): void {
    if (doc?.kind !== 'workstream' || !doc.editable) {
      return;
    }
    queueEdit(patch);
  }

  function saveTopic(patch: TopicPatch): void {
    if (doc?.kind !== 'topic' || !doc.editable) {
      return;
    }
    queueEdit(patch);
  }

  function openTopic(slug: string): void {
    transport.post({ type: 'openTopic', slug });
  }

  function openWorkstream(slug: string): void {
    transport.post({ type: 'openWorkstream', slug });
  }

  function openNanite(id: string): void {
    transport.post({ type: 'openDocument', id });
  }

  function openRoute(route: string): void {
    transport.post({ type: 'openRoute', route });
  }

  function openExternal(url: string): void {
    transport.post({ type: 'openExternal', url });
  }

  function invokeAction(command: string, args: unknown[]): void {
    // args live inside the `doc` $state proxy; postMessage's structured clone
    // throws DataCloneError on a Svelte proxy, so snapshot to a plain value.
    transport.post({ type: 'invoke', command, args: $state.snapshot(args) as unknown[] });
  }

  function togglePinTopic(slug: string): void {
    transport.post({ type: 'togglePinTopic', slug });
  }

  function setAlertStatus(
    id: string,
    status: 'alert' | 'informational' | 'closed',
  ): void {
    transport.post({ type: 'setAlertStatus', id, status });
  }

  // The view registry keyed by kind: workstream / topic get bespoke views; any
  // other kind falls back to the generic DocumentView so nothing is unopenable.
  const view = $derived(doc ? resolveView(doc.kind) : null);
</script>

<main>
  {#if error}
    <div class="banner error">{error}</div>
  {/if}

  {#if staleReload}
    <div class="banner stale">
      <span>This document changed outside the editor.</span>
      <button type="button" onclick={discardAndReload}>
        Discard my edits &amp; reload
      </button>
    </div>
  {/if}

  {#if !doc}
    {#if connecting}
      <div class="loading">Connecting to the control plane…</div>
    {:else}
      <div class="loading">Loading document…</div>
    {/if}
  {:else if view === 'workstream' && doc.kind === 'workstream'}
    <WorkstreamView ws={doc} {saveState} onSave={saveWorkstream} onOpenTopic={openTopic} onOpenNanite={openNanite} onInvoke={invokeAction} onTogglePin={togglePinTopic} onSetAlertStatus={setAlertStatus} />
  {:else if view === 'topic' && doc.kind === 'topic'}
    <TopicView
      topic={doc}
      {saveState}
      onSaveTopic={saveTopic}
      onOpenTopic={openTopic}
      onOpenWorkstream={openWorkstream}
      onSetAlertStatus={setAlertStatus}
    />
  {:else if doc.kind !== 'workstream' && doc.kind !== 'topic'}
    <DocumentView doc={doc} onOpenDocument={openNanite} onOpenRoute={openRoute} onOpenExternal={openExternal} />
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 20px;
  }

  .banner.error {
    padding: 8px 12px;
    border-radius: 4px;
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
    color: var(--vscode-foreground);
  }

  .banner.stale {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 12px;
    border-radius: 4px;
    background: var(--vscode-inputValidation-warningBackground, #4d3800);
    border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
    color: var(--vscode-foreground);
  }

  .banner.stale button {
    flex: none;
    padding: 3px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    cursor: pointer;
  }

  .banner.stale button:hover {
    background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
  }

  .loading {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
</style>
