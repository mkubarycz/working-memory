<script lang="ts">
  import type { TopicBacklogVM } from './types';

  interface Props {
    backlog: TopicBacklogVM;
    onOpenTopic: (slug: string) => void;
  }

  let { backlog, onOpenTopic }: Props = $props();

  function slugFromUri(openUri: string): string {
    try {
      const segment = new URL(openUri).pathname.split('/').at(-1) ?? '';
      return decodeURIComponent(segment.replace(/\.working-memory$/, ''));
    } catch {
      return '';
    }
  }
</script>

<header class="backlog-head">
  <div>
    <p class="eyebrow">Backlog</p>
    <h1>{backlog.title}</h1>
    <p>Open topics that are not part of an active workstream.</p>
  </div>
  <span class="backlog-count">{backlog.topics.length}</span>
</header>

{#if backlog.topics.length === 0}
  <p class="backlog-empty">Every open topic belongs to an active workstream.</p>
{:else}
  <div class="backlog-list">
    {#each backlog.topics as topic (topic.id)}
      {@const slug = slugFromUri(topic.openUri)}
      <button
        class="backlog-row"
        disabled={!slug}
        onclick={() => slug && onOpenTopic(slug)}
      >
        <span aria-hidden="true" class="topic-icon codicon codicon-{topic.icon}"></span>
        <span class="topic-copy">
          <strong>{topic.label}</strong>
          <small>{topic.description || slug}</small>
        </span>
        {#if topic.alertCount}
          <span class="alert-count" class:severe={topic.alertSeverity === 'alert'}>{topic.alertCount}</span>
        {/if}
        <span aria-hidden="true" class="codicon codicon-chevron-right"></span>
      </button>
    {/each}
  </div>
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

  .backlog-list {
    display: grid;
    gap: 1px;
    overflow: hidden;
    border: 1px solid #d1ced0;
    border-radius: 6px;
    background: #d1ced0;
  }

  .backlog-row {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto 18px;
    align-items: center;
    gap: 10px;
    min-height: 52px;
    padding: 8px 12px;
    border: 0;
    background: #ffffff;
    color: #292629;
    text-align: left;
  }

  .backlog-row:hover:not(:disabled),
  .backlog-row:focus-visible {
    outline: none;
    background: #f5edf1;
  }

  .topic-icon {
    color: var(--desktop-accent-strong);
    font-size: 18px;
  }

  .topic-copy {
    display: grid;
    min-width: 0;
    gap: 2px;
  }

  .topic-copy strong,
  .topic-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .topic-copy small {
    color: #6c666b;
  }

  .alert-count {
    display: grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border-radius: 10px;
    background: #666168;
    color: #ffffff;
    font-size: 0.72em;
    font-weight: 800;
  }

  .alert-count.severe {
    background: #c42b1c;
  }

  .backlog-empty {
    padding: 28px;
    border: 1px dashed #c9c6c8;
    border-radius: 6px;
    color: #6c666b;
    text-align: center;
  }
</style>
