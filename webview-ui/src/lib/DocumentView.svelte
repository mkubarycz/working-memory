<script lang="ts">
  import type { GenericDocVM } from './types';

  interface Props {
    doc: GenericDocVM;
  }

  let { doc }: Props = $props();

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
</script>

<header class="head">
  <span class="type-icon codicon codicon-file" title={doc.kind}></span>
  <h1 class="title">{doc.title}</h1>
  <span class="kind-badge">{doc.kind}</span>
</header>

<section class="attrs" aria-label="Document attributes">
  <div class="attr">
    <span class="k">Kind</span>
    <span class="v">{doc.kind}</span>
  </div>
  <div class="attr">
    <span class="k">Id</span>
    <span class="v mono">{doc.id}</span>
  </div>
  <div class="attr">
    <span class="k">Slug</span>
    <span class="v mono">{doc.slug ?? '—'}</span>
  </div>
  <div class="attr">
    <span class="k">Created</span>
    <span class="v">{fmtTs(doc.createdAt)}</span>
  </div>
  <div class="attr">
    <span class="k">Updated</span>
    <span class="v">{fmtTs(doc.updatedAt)}</span>
  </div>
  <div class="attr">
    <span class="k">Resource version</span>
    <span class="v mono">{doc.resourceVersion}</span>
  </div>
</section>

<section class="spec" aria-label="Spec">
  <h2>Spec <span class="count">{doc.spec.length}</span></h2>
  {#if doc.spec.length === 0}
    <p class="empty">This document has no spec fields.</p>
  {:else}
    <dl class="spec-list">
      {#each doc.spec as field (field.key)}
        <div class="spec-row">
          <dt class="mono">{field.key}</dt>
          <dd><pre>{field.value}</pre></dd>
        </div>
      {/each}
    </dl>
  {/if}
</section>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .type-icon {
    font-size: 1.4em;
    color: var(--vscode-foreground);
  }

  .title {
    margin: 0;
    font-size: 1.5em;
    font-weight: 600;
  }

  .kind-badge {
    font-size: 0.75em;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 10px;
    padding: 1px 8px;
  }

  .empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
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

  .mono {
    font-family: var(--vscode-editor-font-family, monospace);
  }

  .spec h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1.05em;
    margin: 0 0 10px;
  }

  .spec .count {
    font-size: 0.75em;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 10px;
    padding: 1px 8px;
  }

  .spec-list {
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border-radius: 6px;
    overflow: hidden;
  }

  .spec-row {
    display: grid;
    grid-template-columns: minmax(120px, 200px) 1fr;
    gap: 12px;
    padding: 8px 14px;
    background: var(--vscode-editor-background);
  }

  .spec-row dt {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    word-break: break-word;
  }

  .spec-row dd {
    margin: 0;
  }

  .spec-row pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }
</style>
