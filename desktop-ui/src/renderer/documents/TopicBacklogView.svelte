<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';
  import type { SvelteSet } from 'svelte/reactivity';
  import ActiveRail from '../ActiveRail.svelte';
  import WorkstreamView from './WorkstreamView.svelte';
  import { resourceDropEffect, topicDropMoves, type ActiveResourceDrag } from '../resourceDrag';
  import { planTopicTransfer } from '../topicTransfer';
  import { selectedPinnedWorkstream } from '../topicBacklog';
  import type { TopicBacklogVM, WorkstreamVM, SaveState } from './types';

  interface Props {
    backlog: TopicBacklogVM;
    treeProps: ComponentProps<typeof ActiveRail>;
    expanded?: SvelteSet<string>;
    activeDrag?: ActiveResourceDrag | null;
    pinnedDocument?: WorkstreamVM | null;
    pinnedSaveState?: SaveState;
    pinnedError?: string;
    workstreamProps?: Omit<ComponentProps<typeof WorkstreamView>, 'ws' | 'saveState' | 'activeDrag'>;
    onSelectPinned?: (id: string) => void;
    selected?: string | null;
  }

  let {
    backlog, treeProps, expanded, activeDrag = $bindable(null),
    pinnedDocument = null, pinnedSaveState = 'idle', pinnedError = '', workstreamProps, onSelectPinned,
    selected = $bindable(null),
  }: Props = $props();
  const pinned = $derived(backlog.pinnedWorkstreams ?? []);
  const card = $derived(selectedPinnedWorkstream(backlog, selected));
  const selectedTab = $derived(card?.id ?? 'backlog');
  const selectedPinnedId = $derived(card?.id);
  $effect(() => {
    const id = selectedPinnedId;
    if (id) untrack(() => onSelectPinned?.(id));
  });

  function pinnedDrop(event: DragEvent, id: string, drop = false): void {
    const source = activeDrag?.kind === 'topic' ? activeDrag : null;
    const request = planTopicTransfer(source, id, topicDropMoves(event));
    if (!request) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = resourceDropEffect(activeDrag, request.move ? 'move' : 'copy');
    selected = id;
    if (drop) { activeDrag = null; treeProps.onTransferTopic(request); }
  }
</script>

<div class="settings-tabs settings-subtabs" role="tablist" aria-label="Workstreams">
  {#each pinned as workstream (workstream.id)}
    <button role="tab" aria-selected={selectedTab === workstream.id}
      onclick={() => selected = workstream.id}
      ondragover={event => pinnedDrop(event, workstream.id)}
      ondrop={event => pinnedDrop(event, workstream.id, true)}
    >{workstream.label}</button>
  {/each}
  <button role="tab" aria-selected={selectedTab === 'backlog'} onclick={() => selected = 'backlog'}>Backlog</button>
</div>

{#if card}
  {#if pinnedError}<p role="alert">{pinnedError}</p>{/if}
  {#if pinnedDocument?.id === card.id && workstreamProps}
    <WorkstreamView {...workstreamProps} ws={pinnedDocument} saveState={pinnedSaveState} bind:activeDrag />
  {:else if !pinnedError}
    <p role="status">Loading {card.label}...</p>
  {/if}
{:else}
<header class="backlog-head">
  <div>
    <p class="eyebrow">Backlog</p>
    <h1>{backlog.title}</h1>
    <p>Backlog workstreams and open topics that are not part of an active workstream.</p>
  </div>
  <span class="backlog-count">{backlog.workstreams.length + backlog.topics.length}</span>
</header>

<ActiveRail {...treeProps} {backlog} {expanded} bind:activeDrag />
{/if}

<style>
  .backlog-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 24px;
    margin-bottom: 18px;
  }

  .backlog-head h1,
  .backlog-head p {
    margin: 0;
  }

  .backlog-head h1 {
    margin: 3px 0 5px;
    font-size: 1.6em;
  }

  .eyebrow {
    color: var(--desktop-accent-strong);
    font-size: 0.72em;
    font-weight: 800;
    text-transform: uppercase;
  }

  .backlog-count {
    display: grid;
    place-items: center;
    min-width: 38px;
    height: 38px;
    border-radius: 19px;
    color: #ffffff;
    font-size: 1.1em;
    font-weight: 800;
    background: var(--desktop-accent-strong);
  }
</style>
