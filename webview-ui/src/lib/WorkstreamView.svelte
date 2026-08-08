<script lang="ts">
  import type { WorkstreamVM } from './types';

  interface Props {
    ws: WorkstreamVM;
    saving: boolean;
    onSave: (patch: { title?: string; status?: string }) => void;
    onOpenTopic: (slug: string) => void;
  }

  let { ws, saving, onSave, onOpenTopic }: Props = $props();

  const STATUSES = ['queue', 'progress', 'backlog', 'closed'];

  function onTitleInput(event: Event): void {
    ws.title = (event.currentTarget as HTMLInputElement).value;
    onSave({ title: ws.title });
  }

  function onStatusChange(event: Event): void {
    ws.status = (event.currentTarget as HTMLSelectElement).value;
    onSave({ status: ws.status });
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

  const pinnedTopics = $derived(ws.topics.filter((t) => t.pinned));
  const otherTopics = $derived(ws.topics.filter((t) => !t.pinned));
</script>

<header class="head">
  {#if ws.editable}
    <input
      class="title-input"
      value={ws.title}
      oninput={onTitleInput}
      aria-label="Workstream title"
    />
  {:else}
    <h1 class="title">{ws.title}</h1>
  {/if}
  {#if saving}<span class="saving">saving…</span>{/if}
</header>

<section class="attrs" aria-label="Workstream attributes">
  <div class="attr">
    <span class="k">Title</span>
    <span class="v">{ws.title}</span>
  </div>
  <div class="attr">
    <span class="k">Slug</span>
    <span class="v mono">{ws.slug ?? '—'}</span>
  </div>
  <div class="attr">
    <span class="k">Status</span>
    <span class="v">
      {#if ws.editable}
        <select value={ws.status} onchange={onStatusChange} aria-label="Status">
          {#each STATUSES as s}
            <option value={s}>{s}</option>
          {/each}
        </select>
      {:else}
        {ws.status}
      {/if}
    </span>
  </div>
  <div class="attr">
    <span class="k">Created</span>
    <span class="v">{fmtTs(ws.createdAt)}</span>
  </div>
  <div class="attr">
    <span class="k">Updated</span>
    <span class="v">{fmtTs(ws.updatedAt)}</span>
  </div>
  <div class="attr">
    <span class="k">Resource version</span>
    <span class="v mono">{ws.resourceVersion}</span>
  </div>
  <div class="attr wide">
    <span class="k">Closure</span>
    <span class="v">{ws.closure?.trim() ? ws.closure : '—'}</span>
  </div>
</section>

<section class="topics" aria-label="Topics">
  <h2>Topics <span class="count">{ws.topics.length}</span></h2>
  {#if ws.topics.length === 0}
    <p class="empty">No topics in this workstream yet.</p>
  {:else}
    {#if pinnedTopics.length > 0}
      <ul class="topic-list">
        {#each pinnedTopics as t (t.slug)}
          <li class="topic pinned">
            <button class="topic-link" onclick={() => onOpenTopic(t.slug)}>
              <span class="pin" title="Pinned to this workstream">★</span>
              <span class="topic-title">{t.title}</span>
              <span class="topic-slug mono">{t.slug}</span>
              {#if t.status !== 'open'}
                <span class="topic-status">{t.status}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if otherTopics.length > 0}
      <ul class="topic-list">
        {#each otherTopics as t (t.slug)}
          <li class="topic">
            <button class="topic-link" onclick={() => onOpenTopic(t.slug)}>
              <span class="topic-title">{t.title}</span>
              <span class="topic-slug mono">{t.slug}</span>
              {#if t.status !== 'open'}
                <span class="topic-status">{t.status}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 12px;
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

  .saving {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
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

  .attr.wide {
    grid-column: 1 / -1;
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

  .topics h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1.05em;
    margin: 0 0 10px;
  }

  .topics .count {
    font-size: 0.75em;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 10px;
    padding: 1px 8px;
  }

  .topic-list {
    list-style: none;
    margin: 0 0 12px;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .topic-link {
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

  .topic-link:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .topic.pinned .topic-link {
    background: var(--vscode-list-inactiveSelectionBackground);
  }

  .pin {
    color: var(--vscode-charts-yellow, #e2c08d);
  }

  .topic-slug {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }

  .topic-status {
    margin-left: auto;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }
</style>
