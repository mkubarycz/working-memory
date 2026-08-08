<script lang="ts">
  import { onMount } from 'svelte';
  import { createVsCodeTransport } from './lib/transport';
  import type { DocumentVM, TopicPatch } from './lib/types';
  import { resolveView } from './lib/viewRegistry';
  import WorkstreamView from './lib/WorkstreamView.svelte';
  import TopicView from './lib/TopicView.svelte';
  import DocumentView from './lib/DocumentView.svelte';

  const transport = createVsCodeTransport();

  let doc = $state<DocumentVM | null>(null);
  let error = $state<string | null>(null);
  let saving = $state(false);

  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    const unsubscribe = transport.subscribe((msg) => {
      if (msg.type === 'document') {
        doc = msg.data;
        error = null;
        saving = false;
      } else if (msg.type === 'error') {
        error = msg.message;
        saving = false;
      }
    });
    transport.post({ type: 'ready' });
    return unsubscribe;
  });

  // Debounced autosave — no dirty state, no save prompt. The host persists
  // through the control-plane API and echoes the fresh view-model back.
  function debounce(fn: () => void): void {
    saving = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(fn, 400);
  }

  function saveWorkstream(patch: { title?: string; status?: string }): void {
    if (doc?.kind !== 'workstream' || !doc.editable) {
      return;
    }
    debounce(() => transport.post({ type: 'save', patch }));
  }

  function saveTopic(patch: TopicPatch): void {
    if (doc?.kind !== 'topic' || !doc.editable) {
      return;
    }
    debounce(() => transport.post({ type: 'saveTopic', patch }));
  }

  function openTopic(slug: string): void {
    transport.post({ type: 'openTopic', slug });
  }

  function openWorkstream(slug: string): void {
    transport.post({ type: 'openWorkstream', slug });
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
    <WorkstreamView ws={doc} {saving} onSave={saveWorkstream} onOpenTopic={openTopic} />
  {:else if view === 'topic' && doc.kind === 'topic'}
    <TopicView
      topic={doc}
      {saving}
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
