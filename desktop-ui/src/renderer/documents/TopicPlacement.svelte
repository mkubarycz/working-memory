<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import { EMBEDDING_HISTORY_GUIDANCE } from '../../../../control-plane/src/embeddingContract';
  import type { TopicPlacement } from '../../../../control-plane/src/topicPlacementContract';
  import type { SearchBugReportInput } from '../../shared/contracts';
  import ReportBugDialog from '../ReportBugDialog.svelte';
  import TopicLink from './TopicLink.svelte';
  import { placementApplyInput, placementBugContext } from './topicPlacementActions';

  let { id, title, resourceVersion, editable, autoLoad = false, environment = '', saved = true,
    onOpenTopic, onOpenWorkstream, onApplied }: {
    id: string; title: string; resourceVersion: number; editable: boolean;
    autoLoad?: boolean; environment?: string; saved?: boolean;
    onOpenTopic: (id: string) => void; onOpenWorkstream: (id: string) => void;
    onApplied?: () => Promise<void>;
  } = $props();
  let result = $state<TopicPlacement | null>(null);
  const selected = $derived(result?.state === 'ready' ? result.suggestions[0] ?? null : null);
  let loading = $state(false);
  let applying = $state(false);
  let error = $state('');
  let notice = $state('');
  let reporting = $state<SearchBugReportInput['search'] | null>(null);
  let generation = 0;
  $effect(() => {
    void id; void resourceVersion; void environment; void saved;
    const automatic = autoLoad && saved;
    const current = ++generation;
    untrack(() => { result = null; error = ''; notice = ''; loading = false; applying = false; });
    const timer = automatic ? setTimeout(() => {
      if (current === generation) void suggest();
    }, 0) : undefined;
    return () => { generation++; clearTimeout(timer); };
  });
  onDestroy(() => { generation++; });

  async function suggest(): Promise<void> {
    if (loading || applying) return;
    const current = ++generation;
    const topicId = id;
    const version = resourceVersion;
    const sourceEnvironment = environment;
    const automatic = autoLoad;
    const sourceSaved = saved;
    const isCurrent = () => current === generation && id === topicId && resourceVersion === version
      && environment === sourceEnvironment && autoLoad === automatic && saved === sourceSaved;
    loading = true; error = ''; notice = ''; result = null;
    try {
      const value = await window.workingMemory.suggestTopicPlacement(topicId);
      if (isCurrent()) {
        if (value.sourceVersion !== version) throw new Error('The topic changed. Refresh it and suggest placement again.');
        result = value;
      }
    } catch (cause) {
      if (isCurrent()) error = cause instanceof Error ? cause.message : String(cause);
    } finally { if (isCurrent()) loading = false; }
  }

  async function apply(): Promise<void> {
    if (!result || !selected || applying || !editable || !saved) return;
    const current = generation;
    const topicId = id;
    const version = resourceVersion;
    const sourceEnvironment = environment;
    const input = placementApplyInput(topicId, result, selected);
    applying = true; error = '';
    try {
      await window.workingMemory.applyTopicPlacement(input);
      if (current !== generation || id !== topicId || resourceVersion !== version || environment !== sourceEnvironment) return;
      result = null;
      notice = 'Placement applied. Existing relationships and topic status were preserved.';
      await onApplied?.();
    } catch (cause) {
      if (current === generation) error = cause instanceof Error ? cause.message : String(cause);
    } finally { if (current === generation) applying = false; }
  }
  function report(): void {
    reporting = $state.snapshot(placementBugContext({ id, title, resourceVersion }, result, selected, error, loading));
  }
</script>

<section class="topic-placement" aria-label="Topic placement">
  <h3>Topic placement</h3>
  <p>Advisory only. Nothing changes until you apply.</p>
  <button disabled={loading || applying || !saved} onclick={suggest}>{loading ? 'Suggesting placement…' : result ? 'Refresh placement' : 'Suggest Placement'}</button>
  {#if result || error || loading || notice}<button onclick={report}>Bug Report</button>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if result?.state === 'disabled'}
    <p role="status">Placement suggestions are unavailable while Search or Embeddings is disabled. Enable them in Settings &gt; Features.</p>
  {:else if result?.state === 'pending'}
    <p role="status">Placement suggestions are waiting for topic and workstream indexing. Retry when indexing is ready. {EMBEDDING_HISTORY_GUIDANCE}</p>
  {:else if result?.state === 'ready'}
    {#if selected}
      <article>
        <div class="placement-relation">
          <span class="relation-label">Parent</span>
          {#if selected.parent}<TopicLink topic={selected.parent} onOpen={onOpenTopic} />
          {:else}<span>No new parent recommended</span>{/if}
        </div>
        <div class="placement-relation">
          <span class="relation-label">Workstream</span>
          <button class="ws-chip" title={selected.workstream.title} onclick={() => onOpenWorkstream(selected!.workstream.id)}>
            <span aria-hidden="true" class="codicon codicon-briefcase"></span>
            <span class="ws-chip-title">{selected.workstream.title}</span>
          </button>
        </div>
        <details><summary>Supporting evidence</summary>
          <p title={selected.confidence.reason}>Similarity {selected.similarity.toFixed(2)} · Confidence {selected.confidence.level}</p>
          <p>{selected.confidence.reason}</p>
          <p>{selected.evidence === 'parent-membership' ? 'Similar topic in this workstream.' : 'Similar workstream content.'}</p>
          {#if result.limited}<p>Only the first 32,000 body characters were indexed.</p>{/if}
          <blockquote>{selected.excerpt}</blockquote>
          <p>Applying adds this placement; it does not remove existing relationships or move descendants.</p>
        </details>
      </article>
      <button disabled={applying || !editable || !saved} onclick={apply}>{applying ? 'Applying…' : 'Apply placement'}</button>
    {:else}<p>No sufficiently similar eligible placement found. You can place the topic manually.</p>{/if}
  {/if}
</section>

{#if reporting}
  <ReportBugDialog onClose={() => { reporting = null; }}
    evidenceDescription="Includes the source topic, embedding readiness, returned suggestions, selected parent and workstream, versions, similarity, supporting excerpts, and errors captured when you clicked Report a bug."
    capture={description => window.workingMemory.createSearchBugReport({ description, search: $state.snapshot(reporting!) })} />
{/if}

<style>
  .topic-placement { margin: 20px 0; padding: 16px; border: 1px solid var(--border-color, #444); border-radius: 6px; }
  h3 { margin: 0; }
  article { margin: 12px 0; padding: 12px; border: 1px solid var(--border-color, #444); border-radius: 4px; }
  blockquote { white-space: pre-wrap; }
  button { margin-right: 6px; }
  .placement-relation { display: flex; align-items: center; gap: 8px; margin: 8px 0; min-width: 0; }
  .relation-label { min-width: 84px; color: var(--desktop-chat-muted); }
  .ws-chip {
    display: flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0;
    text-align: left; padding: 2px 6px; border: none; border-radius: 4px; background: transparent;
    color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 0.95em;
  }
  .ws-chip:hover { background: var(--vscode-list-hoverBackground); text-decoration: underline; }
  .ws-chip:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .ws-chip-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
