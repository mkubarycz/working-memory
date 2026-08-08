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

  // One accumulator + ONE flush timer shared across all fields. Editing title
  // then status inside the debounce window merges into a single patch, so the
  // whole thing persists in one write and nothing is dropped.
  const pending = createPendingPatch<TopicPatch>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const DEBOUNCE_MS = 400;

  onMount(() => {
    const unsubscribe = transport.subscribe((msg) => {
      if (msg.type === 'document') {
        // Echo-stomp guard: while the user has un-flushed edits pending, ignore
        // the document echo so a stale VM can't clobber fields being typed. A
        // clean load (pending empty — e.g. initial render) always applies.
        if (pending.isEmpty()) {
          doc = msg.data;
          error = null;
        }
      } else if (msg.type === 'saved') {
        error = null;
        // Green only when the write is fully settled — a new edit queued after
        // the flush keeps us amber until its own confirmation arrives.
        if (pending.isEmpty()) {
          saveState = 'saved';
        }
      } else if (msg.type === 'error') {
        error = msg.message;
        saveState = 'error';
      }
    });
    transport.post({ type: 'ready' });
    return unsubscribe;
  });

  // Debounced autosave — no dirty state, no save prompt. Each edit merges into
  // the pending patch and (re)arms ONE timer; the flush posts the whole patch.
  function queueEdit(fields: TopicPatch): void {
    pending.merge(fields);
    saveState = 'pending';
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function flush(): void {
    const patch = pending.flush();
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

  function invokeAction(command: string, args: unknown[]): void {
    // args live inside the `doc` $state proxy; postMessage's structured clone
    // throws DataCloneError on a Svelte proxy, so snapshot to a plain value.
    transport.post({ type: 'invoke', command, args: $state.snapshot(args) as unknown[] });
  }

  function togglePinTopic(slug: string): void {
    transport.post({ type: 'togglePinTopic', slug });
  }

  // The view registry keyed by kind: workstream / topic get bespoke views; any
  // other kind falls back to the generic DocumentView so nothing is unopenable.
  const view = $derived(doc ? resolveView(doc.kind) : null);
</script>

<main>
  {#if error}
    <div class="banner error">{error}</div>
  {/if}

  {#if !doc}
    <div class="loading">Loading document…</div>
  {:else if view === 'workstream' && doc.kind === 'workstream'}
    <WorkstreamView ws={doc} {saveState} onSave={saveWorkstream} onOpenTopic={openTopic} onOpenNanite={openNanite} onInvoke={invokeAction} onTogglePin={togglePinTopic} />
  {:else if view === 'topic' && doc.kind === 'topic'}
    <TopicView
      topic={doc}
      {saveState}
      onSaveTopic={saveTopic}
      onOpenTopic={openTopic}
      onOpenWorkstream={openWorkstream}
    />
  {:else if doc.kind !== 'workstream' && doc.kind !== 'topic'}
    <DocumentView doc={doc} />
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

  .loading {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
</style>
