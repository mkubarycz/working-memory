<script lang="ts">
  import type { RelationVM, SaveState, TopicPatch, TopicVM } from './types';
  import { getTopicTypeConfig, iconForTopic } from './viewRegistry';
  import { renderMarkdown } from './markdown';
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

  // Slugs of workstreams this topic is focused/pinned in — drives the glow-up
  // treatment on the merged Workstreams list.
  const focusedSlugs = $derived(
    new Set(topic.focusedWorkstreams.map((w) => w.slug)),
  );

  // Body view mode: default to Preview (reading-first); flip to Edit to modify.
  let bodyMode = $state<'preview' | 'edit'>('preview');
  const renderedBody = $derived(renderMarkdown(topic.body || ''));
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
  <div class="tab-panel">
    <div class="tab-bar" role="tablist" aria-label="Body view mode">
      <button
        type="button"
        role="tab"
        id="tab-preview"
        class="tab"
        class:active={bodyMode === 'preview'}
        aria-selected={bodyMode === 'preview'}
        aria-controls="tabpanel-body"
        onclick={() => (bodyMode = 'preview')}
      >
        Preview
      </button>
      {#if topic.editable}
        <button
          type="button"
          role="tab"
          id="tab-edit"
          class="tab"
          class:active={bodyMode === 'edit'}
          aria-selected={bodyMode === 'edit'}
          aria-controls="tabpanel-body"
          onclick={() => (bodyMode = 'edit')}
        >
          Edit
        </button>
      {/if}
    </div>
    <div
      class="tab-content"
      id="tabpanel-body"
      role="tabpanel"
      aria-labelledby={bodyMode === 'edit' ? 'tab-edit' : 'tab-preview'}
    >
      {#if topic.editable && bodyMode === 'edit'}
        <textarea
          class="body-input"
          value={topic.body}
          oninput={onBodyInput}
          spellcheck="false"
          aria-label="Topic body (Markdown)"
        ></textarea>
      {:else if topic.body}
        <!-- Safe to inject: renderMarkdown uses markdown-it `html: false`, so any
             authored raw HTML is escaped rather than emitted as live markup. -->
        <div class="markdown-body">{@html renderedBody}</div>
      {:else}
        <p class="body-empty">—</p>
      {/if}
    </div>
  </div>
</section>

{#snippet relationGroup(
  label: string,
  rows: RelationVM[],
  open: (slug: string) => void,
  pinnedSlugs?: Set<string>,
)}
  {#if rows.length > 0}
    <section class="relations" aria-label={label}>
      <h2>{label} <span class="count">{rows.length}</span></h2>
      <ul class="relation-list">
        {#each rows as r (r.slug)}
          <li class="relation">
            <button
              class="relation-link"
              class:pinned={pinnedSlugs?.has(r.slug)}
              onclick={() => open(r.slug)}
            >
              <span class="relation-title">{r.title}</span>
              <span class="relation-slug mono">{r.slug}</span>
              {#if pinnedSlugs?.has(r.slug)}
                <span
                  class="codicon codicon-pinned pin-badge"
                  title="Focused in this workstream"
                ></span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/snippet}

{@render relationGroup('Parents', topic.parents, onOpenTopic)}
{@render relationGroup('Workstreams', topic.workstreams, onOpenWorkstream, focusedSlugs)}

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

  /* Tabbed body panel: a bordered content box with editor-style tabs sitting
     on its top edge. The active tab merges into the box (shares the top
     border, no seam) via a -1px bottom margin that overlaps the box border. */
  .tab-panel {
    margin-top: 8px;
  }

  .tab-bar {
    display: flex;
    gap: 2px;
    padding-left: 4px;
  }

  .tab {
    position: relative;
    padding: 5px 16px;
    border: 1px solid transparent;
    border-bottom: none;
    border-top-left-radius: 5px;
    border-top-right-radius: 5px;
    background: var(--vscode-tab-inactiveBackground, rgba(128, 128, 128, 0.12));
    color: var(--vscode-tab-inactiveForeground, var(--vscode-descriptionForeground));
    cursor: pointer;
    font-size: 0.85em;
  }

  .tab:hover {
    background: var(--vscode-tab-hoverBackground, var(--vscode-list-hoverBackground));
    color: var(--vscode-foreground);
  }

  .tab.active {
    /* Merge into the box: same background + shared border, pulled down 1px so
       the tab covers the box's top border and no seam shows. */
    background: var(--vscode-editor-background);
    color: var(--vscode-tab-activeForeground, var(--vscode-foreground));
    border-color: var(
      --vscode-panel-border,
      var(--vscode-widget-border, rgba(128, 128, 128, 0.35))
    );
    margin-bottom: -1px;
    z-index: 1;
  }

  .tab-content {
    min-height: 220px;
    padding: 12px 14px;
    background: var(--vscode-editor-background);
    border: 1px solid var(
      --vscode-panel-border,
      var(--vscode-widget-border, rgba(128, 128, 128, 0.35))
    );
    border-radius: 0 4px 4px 4px;
  }

  .body-input {
    display: block;
    width: 100%;
    min-height: 200px;
    resize: vertical;
    padding: 0;
    color: var(--vscode-input-foreground);
    background: transparent;
    border: none;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    line-height: 1.5;
  }

  .body-input:focus {
    outline: none;
  }

  .body-empty {
    margin: 0;
    color: var(--vscode-descriptionForeground);
  }

  /* Rendered markdown — themed with --vscode-* vars so it reads in light+dark. */
  .markdown-body {
    line-height: 1.6;
    word-break: break-word;
  }

  .markdown-body :global(h1),
  .markdown-body :global(h2),
  .markdown-body :global(h3),
  .markdown-body :global(h4),
  .markdown-body :global(h5),
  .markdown-body :global(h6) {
    margin: 1em 0 0.5em;
    font-weight: 600;
    line-height: 1.3;
  }

  .markdown-body :global(h1) {
    font-size: 1.5em;
  }

  .markdown-body :global(h2) {
    font-size: 1.3em;
  }

  .markdown-body :global(h3) {
    font-size: 1.1em;
  }

  .markdown-body :global(:first-child) {
    margin-top: 0;
  }

  .markdown-body :global(p),
  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: 0.5em 0;
  }

  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    padding-left: 1.5em;
  }

  .markdown-body :global(li) {
    margin: 0.2em 0;
  }

  .markdown-body :global(a) {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }

  .markdown-body :global(a:hover) {
    color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
    text-decoration: underline;
  }

  .markdown-body :global(code) {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    padding: 0.15em 0.35em;
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.1));
  }

  .markdown-body :global(pre) {
    margin: 0.5em 0;
    padding: 10px 12px;
    overflow-x: auto;
    border-radius: 4px;
    background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.1));
  }

  .markdown-body :global(pre code) {
    padding: 0;
    background: none;
    font-size: 0.9em;
  }

  .markdown-body :global(blockquote) {
    margin: 0.5em 0;
    padding: 0.2em 1em;
    color: var(--vscode-descriptionForeground);
    border-left: 3px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.5));
  }

  .markdown-body :global(hr) {
    border: none;
    border-top: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    margin: 1em 0;
  }

  .markdown-body :global(table) {
    border-collapse: collapse;
    margin: 0.5em 0;
  }

  .markdown-body :global(th),
  .markdown-body :global(td) {
    padding: 4px 10px;
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
  }

  .markdown-body :global(th) {
    background: var(--vscode-editorWidget-background, rgba(128, 128, 128, 0.08));
    font-weight: 600;
  }

  .markdown-body :global(img) {
    max-width: 100%;
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

  /* Pinned/focused workstreams get the same warm-yellow glow-up as pinned
     topics in WorkstreamView's tree — kept identical for visual consistency. */
  .relation-link.pinned {
    color: var(--vscode-charts-yellow, #d7ba7d);
    background: color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 12%, transparent);
    box-shadow: inset 0 0 0 1px
      color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 35%, transparent);
    text-shadow: 0 0 6px
      color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 45%, transparent);
    font-weight: 600;
  }

  .relation-link.pinned:hover {
    background: color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 20%, transparent);
  }

  .relation-link.pinned .relation-slug {
    color: color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 70%, var(--vscode-descriptionForeground));
  }

  .pin-badge {
    color: var(--vscode-charts-yellow, #d7ba7d);
    font-size: 0.85em;
  }

  .relation-slug {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
</style>
