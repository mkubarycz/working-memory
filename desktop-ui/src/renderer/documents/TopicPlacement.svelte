<script lang="ts">
  import { onDestroy } from 'svelte';
  import { EMBEDDING_HISTORY_GUIDANCE } from '../../../../control-plane/src/embeddingContract';
  import type { TopicPlacement, TopicPlacementSuggestion } from '../../../../control-plane/src/topicPlacementContract';
  import type { SearchBugReportInput } from '../../shared/contracts';
  import ReportBugDialog from '../ReportBugDialog.svelte';
  import { placementApplyInput, placementBugContext } from './topicPlacementActions';

  let { id, title, resourceVersion, editable, onOpenTopic, onOpenWorkstream, onApplied }: {
    id: string; title: string; resourceVersion: number; editable: boolean;
    onOpenTopic: (id: string) => void; onOpenWorkstream: (id: string) => void;
    onApplied?: () => Promise<void>;
  } = $props();
  let result = $state<TopicPlacement | null>(null);
  let selected = $state<TopicPlacementSuggestion | null>(null);
  let loading = $state(false);
  let applying = $state(false);
  let error = $state('');
  let notice = $state('');
  let reporting = $state<SearchBugReportInput['search'] | null>(null);
  let generation = 0;
  $effect(() => {
    void id; void resourceVersion;
    generation++; result = null; selected = null; error = ''; notice = ''; loading = false; applying = false;
  });
  onDestroy(() => { generation++; });

  async function suggest(): Promise<void> {
    if (loading || applying) return;
    const current = ++generation;
    const topicId = id;
    const version = resourceVersion;
    loading = true; error = ''; notice = ''; result = null; selected = null;
    try {
      const value = await window.workingMemory.suggestTopicPlacement(topicId);
      if (current === generation) {
        if (value.sourceVersion !== version) throw new Error('The topic changed. Refresh it and suggest placement again.');
        result = value;
      }
    } catch (cause) {
      if (current === generation) error = cause instanceof Error ? cause.message : String(cause);
    } finally { if (current === generation) loading = false; }
  }

  async function apply(): Promise<void> {
    if (!result || !selected || applying || !editable) return;
    const current = generation;
    const input = placementApplyInput(id, result, selected);
    applying = true; error = '';
    try {
      await window.workingMemory.applyTopicPlacement(input);
      if (current !== generation) return;
      result = null; selected = null;
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
  <p>Compare this saved topic with existing topic and workstream embeddings. Nothing changes until you apply a selection.</p>
  <button disabled={loading || applying} onclick={suggest}>{loading ? 'Suggesting placement…' : 'Suggest Placement'}</button>
  {#if result || error || loading || notice}<button onclick={report}>Bug Report</button>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if result?.state === 'disabled'}
    <p role="status">Placement suggestions are unavailable while Search or Embeddings is disabled. Enable them in Settings &gt; Features.</p>
  {:else if result?.state === 'pending'}
    <p role="status">Placement suggestions are waiting for topic and workstream indexing. Retry when indexing is ready. {EMBEDDING_HISTORY_GUIDANCE}</p>
  {:else if result?.state === 'ready'}
    {#if result.limited}<p>Only the first 32,000 body characters were indexed.</p>{/if}
    {#each result.suggestions as suggestion, index}
      <article>
        <label><input type="radio" name={`placement-${id}`} checked={selected === suggestion}
          onchange={() => { selected = suggestion; }} disabled={applying} /> Select placement {index + 1}</label>
        <p>Parent:
          {#if suggestion.parent}<button onclick={() => onOpenTopic(suggestion.parent!.id)}>{suggestion.parent.title}</button>
          {:else}No new parent recommended{/if}
          · Workstream: <button onclick={() => onOpenWorkstream(suggestion.workstream.id)}>{suggestion.workstream.title}</button>
        </p>
        <p title={suggestion.confidence.reason}>Similarity {suggestion.similarity.toFixed(2)} · Confidence {suggestion.confidence.level}</p>
        <p>{suggestion.evidence === 'parent-membership' ? 'Similar topic in this workstream.' : 'Similar workstream content.'}</p>
        <details><summary>Supporting excerpt</summary><blockquote>{suggestion.excerpt}</blockquote></details>
      </article>
    {:else}<p>No sufficiently similar eligible placement found. You can place the topic manually.</p>{/each}
    {#if result.suggestions.length}
      <p>Applying adds the selected parent and workstream; it does not remove existing relationships or move descendants.</p>
      <button disabled={!selected || applying || !editable} onclick={apply}>{applying ? 'Applying…' : 'Apply selected placement'}</button>
    {/if}
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
</style>
