<script lang="ts">
  import type { GenericDocVM } from './types';

  interface Props {
    doc: GenericDocVM;
    /** Open a NaniteJournal (or any doc) by id via the by-id route. */
    onOpenDocument: (id: string) => void;
    /** Open a document by its working-memory route (prompt block link-out). */
    onOpenRoute: (route: string) => void;
    /** Open an external URL (e.g. a container's https host) in the browser. */
    onOpenExternal: (url: string) => void;
  }

  let { doc, onOpenDocument, onOpenRoute, onOpenExternal }: Props = $props();

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

  /** Format a journal's end time (unix SECONDS) for the row's trailing meta. */
  function fmtJournalTs(secs: number): string {
    if (!secs) {
      return '';
    }
    try {
      return new Date(secs * 1000).toLocaleString();
    } catch {
      return '';
    }
  }

  /** Format a unix-SECONDS timestamp for the journal detail header (— when 0). */
  function fmtSecs(secs: number): string {
    if (!secs) {
      return '—';
    }
    try {
      return new Date(secs * 1000).toLocaleString();
    } catch {
      return String(secs);
    }
  }

  /** Human label for a run outcome/phase driving the header badge. */
  function outcomeLabel(outcome: 'succeeded' | 'failed' | null, phase: string): string {
    if (outcome === 'succeeded') {
      return 'Succeeded';
    }
    if (outcome === 'failed') {
      return 'Failed';
    }
    return phase || 'Running';
  }

  /** Noun for a prompt-block link-out, chosen from the source field. */
  function blockNoun(field: string): string {
    if (field === 'instructions') {
      return 'Instructions';
    }
    if (field === 'body') {
      return 'Input topic';
    }
    return field ? field.charAt(0).toUpperCase() + field.slice(1) : 'Source';
  }

  /** Friendly label for a prompt-block link-out (e.g. "Instructions — v3"). */
  function blockLabel(field: string, version: string): string {
    return `${blockNoun(field)} — v${version}`;
  }
</script>

{#if doc.naniteJournal}
  {@const nj = doc.naniteJournal}
  <header class="nj-head">
    <h1 class="title">{doc.title}</h1>
    <div class="nj-head-meta">
      <span
        class="nj-outcome codicon"
        class:ok={nj.outcome === 'succeeded'}
        class:fail={nj.outcome === 'failed'}
        class:codicon-pass={nj.outcome === 'succeeded'}
        class:codicon-error={nj.outcome === 'failed'}
        class:codicon-circle-outline={nj.outcome === null}
        title={outcomeLabel(nj.outcome, nj.phase)}
      ></span>
      <span
        class="nj-badge"
        class:ok={nj.outcome === 'succeeded'}
        class:fail={nj.outcome === 'failed'}
      >{outcomeLabel(nj.outcome, nj.phase)}</span>
      {#if nj.duration}
        <span class="nj-meta-item"><span class="codicon codicon-watch"></span> {nj.duration}</span>
      {/if}
      <span class="nj-meta-item">{fmtSecs(nj.endedAt) || fmtSecs(nj.startedAt)}</span>
      <span class="nj-links">
        {#if nj.nanite.id}
          <button class="nj-link" onclick={() => onOpenDocument(nj.nanite.id)} title="Open owning Nanite">
            <span class="codicon codicon-zap"></span>
            <span class="nj-link-label">Nanite</span>
          </button>
        {/if}
        {#if nj.template.id}
          <button class="nj-link" onclick={() => onOpenDocument(nj.template.id)} title="Open Nanite Template">
            <span class="codicon codicon-symbol-class"></span>
            <span class="nj-link-label">Template</span>
          </button>
        {/if}
      </span>
    </div>
  </header>

  {#if nj.callout}
    {@const co = nj.callout}
    {#if co.variant === 'failed'}
      <div class="nj-error" role="alert">
        <span class="codicon codicon-error"></span>
        <pre>{co.reason || '—'}</pre>
      </div>
    {:else}
      <div class="nj-acceptance nj-callout" class:passed={co.variant === 'accepted'} class:rejected={co.variant === 'rejected'}>
        <div class="nj-acceptance-head">
          <span
            class="codicon"
            class:codicon-verified={co.variant === 'accepted'}
            class:codicon-unverified={co.variant === 'rejected'}
          ></span>
          <span class="nj-acceptance-verdict">{co.verdict}</span>
          {#if co.score}
            <span class="nj-acceptance-score mono">{co.score}</span>
          {/if}
        </div>
        {#if co.reason}
          <pre class="nj-acceptance-summary">{co.reason}</pre>
        {/if}
      </div>
    {/if}
  {/if}

  <section class="nj-section" aria-label="Results">
    <h2><span class="codicon codicon-output"></span> Results</h2>
    <div class="nj-field"><span class="nj-field-k">Summary</span><pre>{nj.summary || '—'}</pre></div>
  </section>

  <details class="nj-disclosure">
    <summary><span class="codicon codicon-comment"></span> Prompt</summary>
    {#if nj.promptSegments && nj.promptSegments.length > 0}
      <div class="nj-prompt-segments">
        {#each nj.promptSegments as seg}
          {#if seg.kind === 'block'}
            <details class="nj-block">
              <summary>
                <span class="codicon codicon-link"></span>
                <button
                  class="nj-block-link"
                  title={seg.route}
                  onclick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenRoute(seg.route);
                  }}
                >{blockLabel(seg.field, seg.version)}</button>
              </summary>
              <pre class="nj-prompt">{seg.content}</pre>
            </details>
          {:else}
            <pre class="nj-prompt">{seg.text}</pre>
          {/if}
        {/each}
      </div>
    {:else}
      <pre class="nj-prompt">{nj.request || '—'}</pre>
    {/if}
  </details>

  <section class="nj-section" aria-label="Execution trace">
    <h2><span class="codicon codicon-list-ordered"></span> Execution <span class="count">{nj.rounds.length}</span></h2>
    {#if nj.rounds.length === 0}
      <p class="empty">No execution steps were recorded.</p>
    {:else}
      <ol class="nj-rounds">
        {#each nj.rounds as round, ri (ri)}
          <li class="nj-round">
            <div class="nj-round-head">
              <span class="nj-round-num mono">Round {ri + 1}</span>
              <span class="codicon codicon-hubot nj-round-icon"></span>
            </div>
            {#if round.narration}
              <div class="nj-round-narration"><pre>{round.narration}</pre></div>
            {:else}
              <p class="nj-round-narration empty">No narration for this round.</p>
            {/if}
            {#if round.toolSteps.length > 0}
              <ol class="nj-steps">
                {#each round.toolSteps as step, i (i)}
          <li>
            <details class="nj-step">
              <summary>
                <span class="nj-step-num mono">{i + 1}</span>
                {#if step.kind === 'tool'}
                  <span
                    class="codicon nj-step-status"
                    class:ok={step.ok === true}
                    class:fail={step.ok === false}
                    class:codicon-pass={step.ok === true}
                    class:codicon-error={step.ok === false}
                    class:codicon-circle-outline={step.ok === null}
                    title={step.ok === false ? 'Failed' : step.ok === true ? 'OK' : 'Unknown'}
                  ></span>
                  {#if step.friendly}
                    {@const f = step.friendly}
                    <span class="nj-step-verb">{f.verb}</span>
                    <span class="nj-step-label mono">{f.tool}</span>
                    {#if f.mode === 'list'}
                      {#if f.scope}
                        <span class="nj-step-scope mono">{f.scope}</span>
                      {/if}
                      <span class="nj-step-arrow">→</span>
                      {#each f.items as it (it.route)}
                        <button
                          class="nj-block-link nj-step-friendly-link"
                          title={it.route}
                          onclick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onOpenRoute(it.route);
                          }}
                        >{it.label}</button>
                      {/each}
                      {#if f.moreCount > 0}
                        <span class="nj-step-more">+{f.moreCount} more</span>
                      {/if}
                    {:else}
                      <button
                        class="nj-block-link nj-step-friendly-link"
                        title={f.route}
                        onclick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onOpenRoute(f.route);
                        }}
                      >{f.label} (v{f.version})</button>
                    {/if}
                  {:else}
                    <span class="nj-step-kind tool">tool</span>
                    <span class="nj-step-label mono">{step.label}</span>
                    {#if step.container}
                      {@const c = step.container}
                      <span class="nj-step-container-sep">·</span>
                      {#if c.host}
                        <a
                          class="nj-block-link nj-step-container"
                          href={`https://${c.host}`}
                          title={`Open https://${c.host}`}
                          onclick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            onOpenExternal(`https://${c.host}`);
                          }}
                        >{c.name || c.id}</a>
                      {:else}
                        <span class="nj-step-container mono">{c.name || c.id}</span>
                      {/if}
                    {/if}
                  {/if}
                {:else}
                  <span class="codicon codicon-hubot nj-step-status assistant"></span>
                  <span class="nj-step-kind assistant">assistant</span>
                {/if}
              </summary>
              <div class="nj-step-body">
                {#if step.text}
                  <div class="nj-field"><span class="nj-field-k">Narration</span><pre>{step.text}</pre></div>
                {/if}
                {#if step.input}
                  <div class="nj-field"><span class="nj-field-k">Input</span><pre>{step.input}</pre></div>
                {/if}
                {#if step.result}
                  <div class="nj-field"><span class="nj-field-k">Result</span><pre>{step.result}</pre></div>
                {/if}
                {#if step.error}
                  <div class="nj-field err"><span class="nj-field-k">Error</span><pre>{step.error}</pre></div>
                {/if}
                {#if !step.text && !step.input && !step.result && !step.error}
                  <p class="empty">No detail recorded for this step.</p>
                {/if}
              </div>
            </details>
          </li>
                {/each}
              </ol>
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </section>
{:else}
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
{/if}

{#if doc.journals && doc.journals.length > 0}
  <section class="journals" aria-label="Run history">
    <h2><span class="codicon codicon-history"></span> Run history <span class="count">{doc.journals.length}</span></h2>
    <ul class="tree-list">
      {#each doc.journals as j (j.id)}
        <li class="tree-node">
          <div class="row-wrap">
            <span class="twistie-spacer"></span>
            <button
              class="tree-link"
              class:failed={j.outcome === 'failed'}
              onclick={() => onOpenDocument(j.id)}
              title="Open run journal"
            >
              {#if j.outcome === 'failed'}
                <span class="codicon codicon-error journal-fail-icon" title="Failed"></span>
              {:else if j.outcome === 'succeeded'}
                <span class="codicon codicon-pass journal-ok-icon" title="Succeeded"></span>
              {:else}
                <span class="codicon codicon-circle-outline" title={j.phase}></span>
              {/if}
              <span class="tree-label">{j.summary || j.phase}</span>
              {#if j.duration}
                <span class="journal-duration mono">{j.duration}</span>
              {/if}
              <span class="tree-meta">{fmtJournalTs(j.endedAt) || j.phase}</span>
            </button>
          </div>
        </li>
      {/each}
    </ul>
  </section>
{/if}

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

  /* Run-history list — mirrors the workstream card's topic rows (WorkstreamView
     `.tree-link`) so a nanite's journals read the same as topics on a card. */
  .journals h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1.05em;
    margin: 18px 0 8px;
  }

  .journals .count {
    font-size: 0.75em;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 10px;
    padding: 1px 8px;
  }

  .tree-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .row-wrap {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .twistie-spacer {
    flex: 0 0 auto;
    width: 20px;
  }

  .tree-link {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
    padding: 4px 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 0.95em;
  }

  .tree-link:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .tree-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tree-meta {
    margin-left: auto;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .journal-duration {
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
  }

  .journal-ok-icon {
    color: var(--vscode-charts-green, #89d185);
  }

  .journal-fail-icon {
    color: var(--vscode-errorForeground, var(--vscode-charts-red, #f14c4c));
  }

  /* Failed runs echo WorkstreamView's failed-nanite treatment: red meta. */
  .tree-link.failed .tree-meta {
    color: var(--vscode-errorForeground, var(--vscode-charts-red, #f14c4c));
    font-style: normal;
  }

  /* ---- NaniteJournal detail view ------------------------------------------ */
  .nj-head {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .nj-outcome {
    font-size: 1.15em;
    color: var(--vscode-descriptionForeground);
  }

  .nj-outcome.ok {
    color: var(--vscode-charts-green, #89d185);
  }

  .nj-outcome.fail {
    color: var(--vscode-errorForeground, var(--vscode-charts-red, #f14c4c));
  }

  .nj-head-meta {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }

  .nj-badge {
    font-size: 0.75em;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 10px;
    padding: 1px 8px;
  }

  .nj-badge.ok {
    background: var(--vscode-charts-green, #89d185);
    color: var(--vscode-editor-background);
  }

  .nj-badge.fail {
    background: var(--vscode-errorForeground, var(--vscode-charts-red, #f14c4c));
    color: var(--vscode-editor-background);
  }

  .nj-meta-item {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }

  .nj-links {
    display: inline-flex;
    align-items: center;
    gap: 12px;
  }

  .nj-link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 0;
    border: none;
    background: none;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font-size: 0.85em;
  }

  .nj-link:hover {
    color: var(--vscode-textLink-activeForeground);
    text-decoration: underline;
  }

  .nj-link-label {
    white-space: nowrap;
  }

  .nj-error {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 14px 0 0;
    padding: 10px 14px;
    border-radius: 6px;
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground, #f14c4c));
    background: var(--vscode-inputValidation-errorBackground, rgba(241, 76, 76, 0.1));
    color: var(--vscode-errorForeground, #f14c4c);
  }

  .nj-error pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }

  .nj-disclosure {
    margin: 14px 0 0;
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border-radius: 6px;
    background: var(--vscode-editor-background);
  }

  .nj-disclosure > summary,
  .nj-step > summary {
    cursor: pointer;
    padding: 8px 12px;
    display: flex;
    align-items: center;
    gap: 8px;
    user-select: none;
    list-style: none;
  }

  .nj-disclosure > summary::-webkit-details-marker,
  .nj-step > summary::-webkit-details-marker {
    display: none;
  }

  .nj-disclosure > summary::before,
  .nj-step > summary::before {
    content: '\eab6'; /* codicon chevron-right */
    font-family: codicon;
    font-size: 1em;
    color: var(--vscode-descriptionForeground);
    transition: transform 0.1s ease;
  }

  .nj-disclosure[open] > summary::before,
  .nj-step[open] > summary::before {
    transform: rotate(90deg);
  }

  .nj-prompt {
    margin: 0;
    padding: 0 14px 12px;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
  }

  .nj-prompt-segments {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 4px 8px;
  }

  .nj-block {
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
    border-radius: 4px;
    background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.08));
  }

  .nj-block > summary {
    display: flex;
    align-items: center;
    gap: 6px;
    list-style: none;
    cursor: pointer;
    padding: 6px 10px;
    font-size: 0.85em;
  }

  .nj-block > summary::-webkit-details-marker {
    display: none;
  }

  .nj-block > summary::before {
    content: '\eab6'; /* codicon chevron-right */
    font-family: codicon;
    font-size: 1em;
    color: var(--vscode-descriptionForeground);
    transition: transform 0.1s ease;
  }

  .nj-block[open] > summary::before {
    transform: rotate(90deg);
  }

  .nj-block-link {
    background: none;
    border: none;
    padding: 0;
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
  }

  .nj-block-link:hover {
    color: var(--vscode-textLink-activeForeground);
  }

  .nj-block[open] > summary {
    border-bottom: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.25));
  }

  .nj-section {
    margin-top: 18px;
  }

  .nj-section h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1.05em;
    margin: 0 0 10px;
  }

  .nj-section .count {
    font-size: 0.75em;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 10px;
    padding: 1px 8px;
  }

  .nj-rounds {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .nj-round {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .nj-round-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .nj-round-num {
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border-radius: 10px;
    padding: 1px 8px;
    font-size: 0.8em;
  }

  .nj-round-icon {
    color: var(--vscode-descriptionForeground);
    font-size: 1em;
  }

  .nj-round-narration {
    margin: 0;
  }

  .nj-round-narration pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: inherit;
  }

  .nj-round-narration.empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .nj-steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border-radius: 6px;
    overflow: hidden;
  }

  .nj-step {
    background: var(--vscode-editor-background);
  }

  .nj-step > summary {
    padding: 6px 12px;
  }

  .nj-step-num {
    color: var(--vscode-descriptionForeground);
    font-size: 0.8em;
    min-width: 1.5em;
  }

  .nj-step-status {
    font-size: 1em;
    color: var(--vscode-descriptionForeground);
  }

  .nj-step-status.ok {
    color: var(--vscode-charts-green, #89d185);
  }

  .nj-step-status.fail {
    color: var(--vscode-errorForeground, var(--vscode-charts-red, #f14c4c));
  }

  .nj-step-status.assistant {
    color: var(--vscode-charts-blue, #3794ff);
  }

  .nj-step-kind {
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-radius: 10px;
    padding: 1px 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }

  .nj-step-kind.assistant {
    background: var(--vscode-charts-blue, #3794ff);
    color: var(--vscode-editor-background);
  }

  .nj-step-verb {
    font-size: 0.7em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-radius: 10px;
    padding: 1px 8px;
    background: var(--vscode-charts-green, #388a34);
    color: var(--vscode-editor-background);
  }

  .nj-step-friendly-link {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nj-step-scope {
    font-size: 0.9em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    opacity: 0.85;
  }

  .nj-step-arrow {
    opacity: 0.6;
  }

  .nj-step-more {
    font-size: 0.85em;
    opacity: 0.7;
  }

  .nj-step-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 0.9em;
  }

  .nj-step-container-sep {
    opacity: 0.5;
    font-size: 0.9em;
  }

  .nj-step-container {
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nj-step-body {
    padding: 4px 12px 12px 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .nj-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .nj-field-k {
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }

  .nj-field pre {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.88em;
  }

  .nj-field.err pre,
  .nj-field.err .nj-field-k {
    color: var(--vscode-errorForeground, #f14c4c);
  }

  .nj-acceptance {
    margin-top: 10px;
    padding: 10px 14px;
    border-radius: 6px;
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    background: var(--vscode-editor-background);
  }

  /* Same card, promoted to the top of the body — just a touch more breathing
     room below the header (matches the run-error banner's top margin). */
  .nj-callout {
    margin-top: 14px;
  }

  .nj-acceptance.passed {
    border-left: 3px solid var(--vscode-charts-green, #89d185);
  }

  .nj-acceptance.rejected {
    border-left: 3px solid var(--vscode-errorForeground, var(--vscode-charts-red, #f14c4c));
  }

  .nj-acceptance-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .nj-acceptance.passed .nj-acceptance-head .codicon {
    color: var(--vscode-charts-green, #89d185);
  }

  .nj-acceptance.rejected .nj-acceptance-head .codicon {
    color: var(--vscode-errorForeground, var(--vscode-charts-red, #f14c4c));
  }

  .nj-acceptance-verdict {
    font-weight: 600;
  }

  .nj-acceptance-score {
    margin-left: auto;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
  }

  .nj-acceptance-summary {
    margin: 8px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.88em;
  }
</style>
