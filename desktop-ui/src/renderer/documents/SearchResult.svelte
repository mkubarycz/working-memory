<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { TopicLinkDragController, TopicLinkReference } from '../resourceDrag';
  import type { MatchConfidence } from '../../../../control-plane/src/embeddingContract';
  import { renderMarkdown } from './markdown';
  import TopicLink from './TopicLink.svelte';
  import TopicWorkstreamPicker from './TopicWorkstreamPicker.svelte';

  let { hit, kind = 'Topic', description = '', attachmentBaseUrl = '', topicDrag, href,
    onOpen, onPrepare, onDragStart, onDragEnd, onAddChild, onAdded,
    expanded = false, onToggle }: {
    hit: TopicLinkReference & { excerpt: string; similarity?: number | null; alreadyLinked?: boolean; literalMatch?: boolean; confidence?: MatchConfidence };
    kind?: string; description?: string; attachmentBaseUrl?: string;
    topicDrag?: TopicLinkDragController; href?: string;
    onOpen: (id: string) => void; onPrepare?: () => void;
    onDragStart?: (event: DragEvent) => void; onDragEnd?: () => void;
    onAddChild?: (parent: TopicLinkReference, workstream: TopicLinkReference) => Promise<void>;
    onAdded?: () => void | Promise<void>; expanded?: boolean; onToggle?: () => void;
  } = $props();
  const excerptId = `result-excerpt-${crypto.randomUUID()}`;
  let actionGeneration = 0;
  let error = $state('');
  let notice = $state('');
  let action = $state<{ kind: 'child' | 'attach'; topic: TopicLinkReference } | null>(null);
  onDestroy(() => { actionGeneration++; });

  async function addChild(topic: TopicLinkReference): Promise<void> {
    const current = ++actionGeneration;
    error = '';
    try {
      const parent = await window.workingMemory.openResource('topic', topic.id);
      if (current !== actionGeneration) return;
      if (parent.kind !== 'topic') throw new Error('The selected resource is not a topic.');
      if (!onAddChild) throw new Error('Child-topic creation is unavailable.');
      if (parent.workstreams.length === 1) await onAddChild(topic, parent.workstreams[0]);
      else action = { kind: 'child', topic };
    } catch (cause) {
      if (current === actionGeneration) error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  async function chooseWorkstream(workstream: TopicLinkReference): Promise<void> {
    if (!action) throw new Error('Choose a topic first.');
    if (action.kind === 'child') {
      if (!onAddChild) throw new Error('Child-topic creation is unavailable.');
      await onAddChild(action.topic, workstream);
    } else {
      await window.workingMemory.addSearchTopicToWorkstream(action.topic.id, workstream.id);
      notice = `Added "${action.topic.title}" to "${workstream.title}".`;
      try { await onAdded?.(); }
      catch (cause) { error = `The topic was added, but refreshing failed: ${cause instanceof Error ? cause.message : String(cause)}`; }
    }
  }
</script>

<article data-search-result={hit.id}>
  <div class="topic-row">
    <button class="twistie" aria-expanded={expanded} aria-controls={excerptId}
      aria-label="{expanded ? 'Collapse' : 'Expand'} excerpt for {hit.title}"
      onclick={() => { if (onToggle) onToggle(); else expanded = !expanded; }}>
      <span aria-hidden="true" class="codicon codicon-chevron-{expanded ? 'down' : 'right'}"></span>
    </button>
    {#if kind === 'Topic' && topicDrag}
      <TopicLink topic={hit} drag={topicDrag} {onOpen}
        onAddChild={onAddChild ? topic => void addChild(topic) : undefined}
        onAddToWorkstream={topic => { actionGeneration++; error = ''; action = { kind: 'attach', topic }; }} />
    {:else}
      <a class="document-link" {href} draggable={!!onDragStart} title={hit.title}
        onpointerenter={onPrepare} onpointerdown={onPrepare} onfocus={onPrepare}
        ondragstart={onDragStart} ondragend={onDragEnd}
        onclick={event => { event.preventDefault(); onOpen(hit.id); }}>
        <span aria-hidden="true" class="codicon codicon-file"></span><span class="document-title">{hit.title}</span>
      </a>
    {/if}
    {#if kind !== 'Topic'}<span class="kind">{kind}</span>{/if}
    {#if hit.alreadyLinked}<span class="linked">Already linked</span>{/if}
    {#if hit.literalMatch}<span class="linked" title="Contains the search word or phrase. Term matches are shown before semantic-only matches.">Term match</span>{/if}
      <span class="relevance" title="Vector cosine similarity (-1 to 1). Higher is closer in meaning, not a confidence percentage.">
        Relevance {hit.similarity == null ? 'unavailable' : hit.similarity.toFixed(2)}
      </span>
    <span class="confidence" title={`Evidence strength, not a calibrated probability. ${hit.confidence?.reason ?? 'No matching evidence score is available.'}`}>
      Confidence {hit.confidence ? hit.confidence.level[0].toUpperCase() + hit.confidence.level.slice(1) : 'unavailable'}
    </span>
  </div>
  {#if description}<p class="reason">{description}</p>{/if}
  {#if expanded}
    <blockquote class="excerpt" id={excerptId}>{@html renderMarkdown(hit.excerpt, attachmentBaseUrl)}</blockquote>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
</article>

{#if action}
  <TopicWorkstreamPicker topic={action.topic}
    title={action.kind === 'child' ? 'Workstream for new child topic' : 'Add to workstream'}
    description={action.kind === 'child' ? 'Choose the workstream for the new child topic.' : 'Adds membership without moving the topic, changing its status or removing existing memberships.'}
    submitLabel={action.kind === 'child' ? 'Continue' : 'Add'}
    onChoose={chooseWorkstream} onClose={() => { action = null; }} />
{/if}

<style>
  article { padding: 4px 0; min-width: 0; }
  .topic-row { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .twistie {
    flex: 0 0 auto; display: flex; align-items: center; justify-content: center;
    width: 20px; height: 22px; padding: 0; border: none; border-radius: 4px;
    background: transparent; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer;
  }
  .twistie:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
  .twistie:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .document-link {
    display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0;
    padding: 4px 8px; border-radius: 4px; color: var(--vscode-foreground); font-size: 0.95em; text-decoration: none;
  }
  .document-link:hover { background: var(--vscode-list-hoverBackground); }
  .document-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kind, .linked, .relevance, .confidence { flex: 0 0 auto; font-size: 0.8em; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .confidence { margin-left: 8px; }
  .linked, .kind { margin-right: 8px; }
  .relevance { font-variant-numeric: tabular-nums; }
  .reason { margin: 2px 0 4px 30px; font-size: 0.9em; line-height: 1.5; overflow-wrap: anywhere; }
  .error { color: var(--vscode-errorForeground); }
  .notice { padding: 8px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
  .excerpt {
    margin: 6px 0 8px 30px; padding: 4px 12px;
    border-left: 3px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.5));
    color: var(--vscode-descriptionForeground); line-height: 1.6; overflow-wrap: anywhere;
  }
  .excerpt :global(:first-child) { margin-top: 0; }
  .excerpt :global(:last-child) { margin-bottom: 0; }
  .excerpt :global(p), .excerpt :global(ul), .excerpt :global(ol) { margin: 0.5em 0; }
  .excerpt :global(ul), .excerpt :global(ol) { padding-left: 1.5em; }
  .excerpt :global(h1), .excerpt :global(h2), .excerpt :global(h3) { font-size: 1.1em; line-height: 1.3; }
  .excerpt :global(a) { color: var(--vscode-textLink-foreground); }
  .excerpt :global(code) { font-family: var(--vscode-editor-font-family, monospace); font-size: 0.9em; }
  .excerpt :global(pre) { padding: 8px; overflow-x: auto; background: var(--vscode-textCodeBlock-background); }
  .excerpt :global(blockquote) { margin-left: 0; padding-left: 12px; border-left: 2px solid var(--vscode-widget-border); }
  .excerpt :global(table) { border-collapse: collapse; }
  .excerpt :global(th), .excerpt :global(td) { padding: 4px 8px; border: 1px solid var(--vscode-widget-border); }
  .excerpt :global(img) { max-width: 100%; }
</style>
