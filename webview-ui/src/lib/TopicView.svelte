<script lang="ts">
  import type { RelationVM, SaveState, TopicPatch, TopicVM } from './types';
  import { getTopicTypeConfig, iconForTopic } from './viewRegistry';
  import SaveStatus from './SaveStatus.svelte';

  interface Props {
    topic: TopicVM;
    saveState: SaveState;
    onSaveTopic: (patch: TopicPatch) => void;
    onOpenTopic: (slug: string) => void;
    onOpenWorkstream: (slug: string) => void;
  }

  let { topic, saveState, onSaveTopic, onOpenTopic, onOpenWorkstream }: Props =
    $props();

  const STATUSES = ['open', 'closed'];

  function onTitleInput(event: Event): void {
    topic.title = (event.currentTarget as HTMLInputElement).value;
    onSaveTopic({ title: topic.title });
  }

  function onStatusChange(event: Event): void {
    topic.status = (event.currentTarget as HTMLSelectElement).value;
    onSaveTopic({ status: topic.status });
  }

  function onBodyInput(event: Event): void {
    topic.body = (event.currentTarget as HTMLTextAreaElement).value;
    onSaveTopic({ body: topic.body });
  }

  function fmtTs(ts: number): string {
    if (!ts) {
      return '—';
    }
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }

  // Type-aware icon + label: the control-plane TopicType icon drives the header,
  // with a registry override / shared fallback resolved in `iconForTopic`.
  const icon = $derived(iconForTopic(topic.topicType, topic.typeMeta?.icon));
  const typeLabel = $derived(topic.typeMeta?.label ?? topic.topicType);
  // Per-type extra settings (empty for types with no registry entry).
  const extraSettings = $derived(
    getTopicTypeConfig(topic.topicType).extraSettings ?? [],
  );
</script>

<header class="head">
  <span class="type-icon codicon codicon-{icon}" title={typeLabel}></span>
  {#if topic.editable}
    <input
      class="title-input"
      value={topic.title}
      oninput={onTitleInput}
      aria-label="Topic title"
    />
  {:else}
    <h1 class="title">{topic.title}</h1>
  {/if}
  <SaveStatus state={saveState} />
</header>

<section class="attrs" aria-label="Topic attributes">
  <div class="attr">
    <span class="k">Type</span>
    <span class="v type-value">
      <span class="codicon codicon-{icon}"></span>
      {typeLabel}
    </span>
  </div>
  <div class="attr">
    <span class="k">Slug</span>
    <span class="v mono">{topic.slug ?? '—'}</span>
  </div>
  <div class="attr">
    <span class="k">Status</span>
    <span class="v">
      {#if topic.editable}
        <select value={topic.status} onchange={onStatusChange} aria-label="Status">
          {#each STATUSES as s}
            <option value={s}>{s}</option>
          {/each}
        </select>
      {:else}
        {topic.status}
      {/if}
    </span>
  </div>
  <div class="attr">
    <span class="k">Created</span>
    <span class="v">{fmtTs(topic.createdAt)}</span>
  </div>
  <div class="attr">
    <span class="k">Updated</span>
    <span class="v">{fmtTs(topic.updatedAt)}</span>
  </div>
  <div class="attr">
    <span class="k">Resource version</span>
    <span class="v mono">{topic.resourceVersion}</span>
  </div>
  {#each extraSettings as setting (setting.label)}
    <div class="attr">
      <span class="k">{setting.label}</span>
      <span class="v">{setting.value(topic)}</span>
    </div>
  {/each}
</section>

<section class="body-section" aria-label="Topic body">
  <h2>Body</h2>
  {#if topic.editable}
    <textarea
      class="body-input"
      value={topic.body}
      oninput={onBodyInput}
      spellcheck="false"
      aria-label="Topic body (Markdown)"
    ></textarea>
  {:else}
    <pre class="body-readonly">{topic.body || '—'}</pre>
  {/if}
</section>

{#snippet relationGroup(label: string, rows: RelationVM[], open: (slug: string) => void)}
  {#if rows.length > 0}
    <section class="relations" aria-label={label}>
      <h2>{label} <span class="count">{rows.length}</span></h2>
      <ul class="relation-list">
        {#each rows as r (r.slug)}
          <li class="relation">
            <button class="relation-link" onclick={() => open(r.slug)}>
              <span class="relation-title">{r.title}</span>
              <span class="relation-slug mono">{r.slug}</span>
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/snippet}

{@render relationGroup('Parents', topic.parents, onOpenTopic)}
{@render relationGroup('Workstreams', topic.workstreams, onOpenWorkstream)}
{@render relationGroup('Focused in', topic.focusedWorkstreams, onOpenWorkstream)}

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .type-icon {
    font-size: 1.4em;
    color: var(--vscode-symbolIcon-keywordForeground, var(--vscode-foreground));
  }

  .title {
    margin: 0;
    font-size: 1.5em;
    font-weight: 600;
  }

  .title-input {
    flex: 1;
    font-size: 1.5em;
    font-weight: 600;
    padding: 4px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }

  .title-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .attrs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1px;
    background: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border-radius: 6px;
    overflow: hidden;
  }

  .attr {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 14px;
    background: var(--vscode-editor-background);
  }

  .attr .k {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }

  .attr .v {
    font-size: 0.95em;
    word-break: break-word;
  }

  .type-value {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .mono {
    font-family: var(--vscode-editor-font-family, monospace);
  }

  select {
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 4px;
    padding: 2px 6px;
  }

  h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1.05em;
    margin: 0 0 10px;
  }

  .count {
    font-size: 0.75em;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 10px;
    padding: 1px 8px;
  }

  .body-input {
    width: 100%;
    min-height: 220px;
    resize: vertical;
    padding: 10px 12px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    line-height: 1.5;
  }

  .body-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .body-readonly {
    margin: 0;
    padding: 10px 12px;
    white-space: pre-wrap;
    word-break: break-word;
    background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.1));
    border-radius: 4px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }

  .relation-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .relation-link {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 6px 10px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 0.95em;
  }

  .relation-link:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .relation-slug {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
</style>
