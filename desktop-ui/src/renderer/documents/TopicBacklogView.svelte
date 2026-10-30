<script lang="ts">
  import type { ComponentProps } from 'svelte';
  import ActiveRail from '../ActiveRail.svelte';
  import type { ActiveResourceDrag } from '../resourceDrag';
  import type { TopicBacklogVM } from './types';

  interface Props {
    backlog: TopicBacklogVM;
    treeProps: ComponentProps<typeof ActiveRail>;
    activeDrag?: ActiveResourceDrag | null;
  }

  let { backlog, treeProps, activeDrag = $bindable(null) }: Props = $props();
</script>

<header class="backlog-head">
  <div>
    <p class="eyebrow">Backlog</p>
    <h1>{backlog.title}</h1>
    <p>Backlog workstreams and open topics that are not part of an active workstream.</p>
  </div>
  <span class="backlog-count">{backlog.workstreams.length + backlog.topics.length}</span>
</header>

<ActiveRail {...treeProps} {backlog} bind:activeDrag />

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
