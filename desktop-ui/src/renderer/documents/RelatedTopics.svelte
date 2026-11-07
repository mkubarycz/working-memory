<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte';
  import type { RelatedTopics } from '../../../../control-plane/src/embeddingContract';
  import { startVisiblePolling } from '../visiblePolling';
  import { TopicLinkDragController, type ActiveResourceDrag, type TopicLinkReference } from '../resourceDrag';
  import SearchResult from './SearchResult.svelte';

  let { id, resourceVersion, onOpenTopic, attachmentBaseUrl = '', activeDrag = $bindable(null), onAddChild, onAdded }: {
    id: string; resourceVersion: number; onOpenTopic: (id: string) => void;
    attachmentBaseUrl?: string;
    activeDrag?: ActiveResourceDrag | null;
    onAddChild?: (parent: TopicLinkReference, workstream: TopicLinkReference) => Promise<void>;
    onAdded?: () => Promise<void>;
  } = $props();
  let result = $state<RelatedTopics | null>(null);
  let error = $state('');
  let mounted = $state(false);
  let expanded = $state<string[]>([]);
  let expandedFor: string | null = null;
  let generation = 0;
  let actionError = $state('');
  const topicDrags = new TopicLinkDragController(
    window.workingMemory, () => activeDrag, value => { activeDrag = value; },
    message => { actionError = message; console.error(message); },
  );
  function toggleExcerpt(topicId: string): void {
    expanded = expanded.includes(topicId) ? expanded.filter(value => value !== topicId) : [...expanded, topicId];
  }
  onMount(() => { mounted = true; return topicDrags.listen(); });
  onDestroy(() => { topicDrags.dispose(); });
  $effect(() => {
    if (!mounted) return;
    const topicId = id;
    if (expandedFor !== topicId) {
      expanded = []; expandedFor = topicId;
      actionError = '';
      topicDrags.clear();
    }
    void resourceVersion;
    const current = ++generation;
    result = null;
    error = '';
    return untrack(() => {
      let busy = false;
      const stop = startVisiblePolling(async () => {
        if (busy) return;
        busy = true;
        try {
          const value = await window.workingMemory.getRelatedTopics(topicId);
          if (generation === current) {
            topicDrags.clear();
            result = value; error = '';
            if (value.state === 'disabled') expanded = [];
          }
        } catch (cause) {
          if (generation === current) error = cause instanceof Error ? cause.message : String(cause);
        } finally { busy = false; }
      }, 15000);
      return () => { generation++; stop(); };
    });
  });
</script>

<svelte:window onpointermove={event => { if (event.buttons === 0 && topicDrags.native) topicDrags.finish(); }}
  onpointerup={event => { if (event.buttons === 0 && topicDrags.native) topicDrags.finish(); }} />

{#if error || (result && result.state !== 'disabled')}
<section class="related-topics" aria-label="Related topics">
  <h3>Related topics</h3>
  {#if actionError}<p role="alert">{actionError}</p>{/if}
  {#if error}<p role="status">{error}</p>
  {:else if result}
    {#if result.state === 'pending'}
      <p role="status">Semantic suggestions are waiting for indexing.
        Check progress in Settings &gt; Diagnostics &gt; Embeddings.</p>
    {/if}
    {#if result.limited}<p role="status">V1 uses the first 32,000 body characters of this topic.</p>{/if}
    {#if result.state === 'ready'}
    {#each result.results.filter(hit => hit.evidence !== 'keyword') as hit (hit.id)}
      <SearchResult {hit} topicDrag={topicDrags} onOpen={onOpenTopic}
        {attachmentBaseUrl} {onAddChild} {onAdded}
        expanded={expanded.includes(hit.id)} onToggle={() => toggleExcerpt(hit.id)} />
    {:else}<p>No related topics found yet.</p>{/each}
    {/if}
  {:else}<p role="status">Finding related topics...</p>{/if}
</section>
{/if}

<style>
  .related-topics { margin: 20px 0; padding: 16px; border: 1px solid var(--border-color, #444); border-radius: 6px; }
  h3 { margin: 0; }
</style>
