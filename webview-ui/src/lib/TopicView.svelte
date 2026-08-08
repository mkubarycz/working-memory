<script lang="ts">
  import type { AlertVM, SaveState, TopicPatch, TopicVM } from './types';
  import { getTopicTypeConfig, iconForTopic } from './viewRegistry';
  import { renderMarkdown } from './markdown';
  import SaveStatus from './SaveStatus.svelte';
  import AlertCallouts from './AlertCallouts.svelte';

  interface Props {
    topic: TopicVM;
    saveState: SaveState;
    onSaveTopic: (patch: TopicPatch) => void;
    onOpenTopic: (slug: string) => void;
    onOpenWorkstream: (slug: string) => void;
    onSetAlertStatus: (id: string, status: AlertVM['status']) => void;
  }

  let {
    topic,
    saveState,
    onSaveTopic,
    onOpenTopic,
    onOpenWorkstream,
    onSetAlertStatus,
  }: Props = $props();

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

  // Family-tree scroll cues: show top/bottom fades only when there's more to
  // scroll in that direction, so the lineage reads as scrollable.
  let scrollEl = $state<HTMLDivElement | null>(null);
  let canUp = $state(false);
  let canDown = $state(false);

  function updateScrollCues(): void {
    const el = scrollEl;
    if (!el) {
      canUp = false;
      canDown = false;
      return;
    }
    canUp = el.scrollTop > 1;
    canDown = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
  }

  $effect(() => {
    const el = scrollEl;
    // Re-run when the lineage changes so cues track the new content height.
    void topic.parents;
    void topic.children;
    if (!el) {
      canUp = false;
      canDown = false;
      return;
    }
    updateScrollCues();
    const ro = new ResizeObserver(() => updateScrollCues());
    ro.observe(el);
    return () => ro.disconnect();
  });
</script>

<header class="head">
  <span class="type-icon codicon codicon-{icon}" title={typeLabel}></span>
  {#if topic.editable}
    <input
      class="title-input"
      value={topic.title}
      oninput={onTitleInput}
      aria-label="Topic title"
      title={topic.title}
    />
  {:else}
    <h1 class="title" title={topic.title}>{topic.title}</h1>
  {/if}
  <span class="rv-label mono" title="Resource version">v{topic.resourceVersion}</span>
  <SaveStatus state={saveState} />
</header>

<div class="head-meta">
  <span class="mono">{topic.slug ?? '—'}</span>
  <span class="hm-dot">·</span>
  <span>Created {fmtTs(topic.createdAt)}</span>
  <span class="hm-dot">·</span>
  <span>Updated {fmtTs(topic.updatedAt)}</span>
</div>

<div class="header-grid">
<section class="attrs" aria-label="Topic attributes">
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
    <span class="k">Workstreams</span>
    <span class="v ws-cell">
      {#each topic.workstreams as w (w.slug)}
        <button
          class="ws-chip"
          class:pinned={focusedSlugs.has(w.slug)}
          onclick={() => onOpenWorkstream(w.slug)}
          title={w.slug}
        >
          <span class="ws-chip-title">{w.title}</span>
          {#if focusedSlugs.has(w.slug)}
            <span class="codicon codicon-pinned pin-badge" title="Focused here"></span>
          {/if}
        </button>
      {/each}
      {#if topic.workstreams.length === 0}—{/if}
    </span>
  </div>
  {#each extraSettings as setting (setting.label)}
    <div class="attr">
      <span class="k">{setting.label}</span>
      <span class="v">{setting.value(topic)}</span>
    </div>
  {/each}
</section>

  <aside class="family" aria-label="Family tree">
    <h2 class="family-title">
      <span class="codicon codicon-type-hierarchy"></span>
      Family tree
    </h2>
    <div class="family-scroll" bind:this={scrollEl} onscroll={updateScrollCues}>
      {#if topic.parents.length > 0}
        <div class="fam-group">
          <span class="fam-label">Parents</span>
          {#each topic.parents as p (p.slug)}
            <button class="fam-row" onclick={() => onOpenTopic(p.slug)} title={p.slug}>
              <span class="fam-row-title">{p.title}</span>
              {#if p.alertCount > 0}
                <span
                  class="alert-count"
                  class:sev-alert={p.alertSeverity === 'alert'}
                  title="{p.alertCount} open alert{p.alertCount === 1 ? '' : 's'}"
                >{p.alertCount}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      {#if topic.children.length > 0}
        <div class="fam-group">
          <span class="fam-label">Children</span>
          {#each topic.children as c (c.slug)}
            <button class="fam-row" onclick={() => onOpenTopic(c.slug)} title={c.slug}>
              <span class="fam-row-title">{c.title}</span>
              {#if c.alertCount > 0}
                <span
                  class="alert-count"
                  class:sev-alert={c.alertSeverity === 'alert'}
                  title="{c.alertCount} open alert{c.alertCount === 1 ? '' : 's'}"
                >{c.alertCount}</span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}

      {#if topic.parents.length === 0 && topic.children.length === 0}
        <p class="fam-empty">No lineage.</p>
      {/if}
    </div>
    <div class="fam-fade fam-fade-top" class:show={canUp} aria-hidden="true"></div>
    <div class="fam-fade fam-fade-bottom" class:show={canDown} aria-hidden="true">
      <span class="codicon codicon-chevron-down fam-fade-chevron"></span>
    </div>
  </aside>
</div>

<AlertCallouts alerts={topic.alerts} {onSetAlertStatus} />

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

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  /* Slug + timestamps as a compact plain-text subline under the title bar,
     freeing those cells out of the attributes grid. */
  .head-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 2px 0 6px;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
  }

  .hm-dot {
    opacity: 0.5;
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
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 10px 14px;
    background: var(--vscode-editor-background);
  }

  .attr {
    display: flex;
    flex-direction: column;
    gap: 4px;
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

  /* Header grid: the attributes table + the family-tree column read as ONE
     bordered table — the 1px gap over a border-colored background draws the
     seams as gridlines. The family column spans the full height of the attrs
     rows (grid stretch). Collapses to a single column when the editor is narrow. */
  .header-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 1px;
    background: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border-radius: 6px;
    overflow: hidden;
    align-items: stretch;
  }

  @media (min-width: 720px) {
    .header-grid {
      grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
    }
  }

  /* The family column stretches to the attributes table's height (grid stretch).
     The scroll list is absolutely positioned so it is OUT of flow and never adds
     to the row height — the table is sized by the attributes alone, and the
     lineage scrolls inside whatever height that gives us. min-height keeps it
     usable when the layout collapses to a single column (family stacks below). */
  .family {
    position: relative;
    background: var(--vscode-editor-background);
    padding: 10px 12px;
    min-width: 0;
    min-height: 160px;
    overflow: hidden;
  }

  .family-title {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0;
    font-size: 0.95em;
  }

  .family-scroll {
    position: absolute;
    top: 34px;
    left: 12px;
    right: 12px;
    bottom: 10px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Scroll affordances: a fade at the top/bottom of the family list, shown only
     when there's more lineage to scroll in that direction. The bottom one holds
     a down-chevron so the cue reads unambiguously. Aligned to .family-scroll's
     insets; pointer-events:none so they never block clicks. */
  .fam-fade {
    position: absolute;
    left: 12px;
    right: 12px;
    height: 22px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.12s ease;
  }

  .fam-fade.show {
    opacity: 1;
  }

  .fam-fade-top {
    top: 34px;
    background: linear-gradient(to bottom, var(--vscode-editor-background), transparent);
  }

  .fam-fade-bottom {
    bottom: 10px;
    background: linear-gradient(to top, var(--vscode-editor-background), transparent);
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }

  .fam-fade-chevron {
    font-size: 0.9em;
    color: var(--vscode-descriptionForeground);
  }

  .fam-group {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .fam-label {
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }

  .fam-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    text-align: left;
    padding: 4px 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 0.88em;
  }

  .fam-row:hover {
    background: var(--vscode-list-hoverBackground);
    text-decoration: underline;
  }

  .fam-row-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Open-alert count bubble on a family-tree row (neutral / red for actionable). */
  .alert-count {
    margin-left: auto;
    flex: none;
    min-width: 16px;
    height: 16px;
    padding: 0 5px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    font-size: 0.72em;
    font-weight: 600;
    line-height: 1;
    color: var(--vscode-badge-foreground, #fff);
    background: var(--vscode-badge-background, #4d4d4d);
  }

  .alert-count.sev-alert {
    color: #fff;
    background: var(--vscode-editorError-foreground, #f14c4c);
  }

  .fam-empty {
    margin: 0;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
    font-size: 0.88em;
  }

  /* Workstreams live in the attributes grid (where resource-version used to be),
     rendered as small clickable chips with the same warm-yellow pin glow. */
  .ws-cell {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
  }

  .ws-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 100%;
    text-align: left;
    padding: 2px 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 0.95em;
  }

  .ws-chip:hover {
    background: var(--vscode-list-hoverBackground);
    text-decoration: underline;
  }

  .ws-chip-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ws-chip.pinned {
    color: var(--vscode-charts-yellow, #d7ba7d);
    background: color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 12%, transparent);
    font-weight: 600;
  }

  .ws-chip.pinned:hover {
    background: color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 20%, transparent);
  }

  .pin-badge {
    color: var(--vscode-charts-yellow, #d7ba7d);
    font-size: 0.85em;
    flex: none;
  }

  .rv-label {
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    white-space: nowrap;
  }
</style>
