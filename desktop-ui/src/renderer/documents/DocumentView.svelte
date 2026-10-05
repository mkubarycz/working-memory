<script lang="ts">
  import type { GenericDocVM } from './types';

  interface Props {
    doc: GenericDocVM;
  }

  let { doc }: Props = $props();

  function fmtTs(ts: number): string {
    if (!ts) return '—';
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
  <div class="attr"><span class="k">Kind</span><span class="v">{doc.kind}</span></div>
  <div class="attr"><span class="k">Id</span><span class="v mono">{doc.id}</span></div>
  <div class="attr"><span class="k">Slug</span><span class="v mono">{doc.slug ?? '—'}</span></div>
  <div class="attr"><span class="k">Created</span><span class="v">{fmtTs(doc.createdAt)}</span></div>
  <div class="attr"><span class="k">Updated</span><span class="v">{fmtTs(doc.updatedAt)}</span></div>
  <div class="attr"><span class="k">Resource version</span><span class="v mono">{doc.resourceVersion}</span></div>
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
  .type-icon { font-size: 1.4em; color: var(--vscode-foreground); }
  .title { margin: 0; font-size: 1.5em; font-weight: 600; }
  .kind-badge, .count {
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background);
    border-radius: 10px;
    padding: 1px 7px;
    font-size: 0.78em;
  }
  .attrs {
    margin-top: 18px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px 18px;
  }
  .attr { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .k { color: var(--vscode-descriptionForeground); font-size: 0.78em; text-transform: uppercase; }
  .v { overflow-wrap: anywhere; }
  .mono { font-family: var(--vscode-editor-font-family); }
  .spec { margin-top: 24px; }
  .spec h2 { display: flex; align-items: center; gap: 8px; font-size: 1.05em; }
  .spec-list { margin: 0; }
  .spec-row { border-top: 1px solid var(--vscode-panel-border); padding: 10px 0; }
  .spec-row dt { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .spec-row dd { margin: 4px 0 0; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
