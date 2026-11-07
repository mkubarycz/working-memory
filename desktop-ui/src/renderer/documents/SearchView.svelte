<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { ExplainedSearchHit } from '../../../../shared/documentSearch';
  import type { DesktopResourceKind } from '../../shared/contracts';
  import { desktopDeepLink } from '../../shared/deepLink';
  import type { SearchViewState } from '../documentSearch';
  import { ResourceDragPreparationCache, setResourceDragData, TopicLinkDragController, type ActiveResourceDrag, type TopicLinkReference } from '../resourceDrag';
  import SearchResult from './SearchResult.svelte';

  let { state: session = $bindable(), activeDrag = $bindable(null), onOpen, onAdded, onAddChild, attachmentBaseUrl = '' }: {
    state: SearchViewState;
    activeDrag?: ActiveResourceDrag | null;
    onOpen: (kind: DesktopResourceKind, id: string) => void | Promise<void>;
    onAdded: () => void | Promise<void>;
    onAddChild?: (parent: TopicLinkReference, workstream: TopicLinkReference) => Promise<void>;
    attachmentBaseUrl?: string;
  } = $props();
  const sources = $derived(new Map(session.response?.results.map(hit => [hit.id, hit]) ?? []));
  const resourceDrags = new ResourceDragPreparationCache(
    (openUri, label) => window.workingMemory.prepareResourceDrag(openUri, label),
    error => { session.error = `Unable to prepare drag context: ${error instanceof Error ? error.message : String(error)}`; },
  );
  let nativeDragFilePath: string | null = null;
  let ownedDrag: ActiveResourceDrag | null = null;
  let topicDrags = $state<TopicLinkDragController | null>(null);

  onMount(() => {
    topicDrags = new TopicLinkDragController(
      window.workingMemory, () => activeDrag, value => { activeDrag = value; },
      message => { session.error = message; console.error(message); },
    );
    const stopTopicDrag = topicDrags.listen();
    const stopTrace = window.workingMemory.onDocumentSearchTrace(({ requestId, trace }) => {
      if (session.requestId === requestId) session.trace = [...session.trace, trace];
    });
    const stopResults = window.workingMemory.onDocumentSearchResults(({ requestId, response }) => {
      if (session.requestId === requestId) session.response = response;
    });
    const stopDrag = window.workingMemory.onResourceDragResult(result => {
      if (result.filePath !== nativeDragFilePath || result.status !== 'failed') return;
      finishDrag();
      session.error = `Unable to drag Working Memory context: ${result.error ?? 'Native drag failed.'}`;
    });
    return () => { stopTrace(); stopResults(); stopDrag(); stopTopicDrag(); };
  });
  $effect.pre(() => {
    session.response;
    resourceDrags.clear();
    topicDrags?.clear();
  });
  onDestroy(() => { resourceDrags.clear(); finishDrag(); topicDrags?.dispose(); });

  function dragUri(hit: ExplainedSearchHit): string {
    return `working-memory:/${route(hit)}/${encodeURIComponent(hit.id)}.working-memory`;
  }

  function startDrag(event: DragEvent, hit: ExplainedSearchHit): void {
    event.stopPropagation();
    const openUri = dragUri(hit);
    const prepared = resourceDrags.get(openUri);
    event.dataTransfer?.clearData();
    if (!setResourceDragData(event.dataTransfer, openUri, hit.title, prepared)) {
      event.preventDefault();
      session.error = 'Unable to drag this Working Memory link.';
      return;
    }
    ownedDrag = hit.kind === 'Topic' ? { kind: 'topic', id: hit.id, sourceWorkstream: '', ...(prepared ? { native: true } : {}) }
      : hit.kind === 'Workstream' && prepared?.workstreamSection
        ? { kind: 'workstream', id: hit.id, section: prepared.workstreamSection, native: true } : null;
    if (ownedDrag) {
      activeDrag = ownedDrag;
      ownedDrag = activeDrag;
    }
    if (ownedDrag?.kind === 'workstream' && event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    if (!prepared) return;
    event.preventDefault();
    nativeDragFilePath = prepared.filePath;
    window.workingMemory.startResourceDrag(prepared);
  }

  function finishDrag(): void {
    if (ownedDrag && activeDrag === ownedDrag) activeDrag = null;
    ownedDrag = null;
    nativeDragFilePath = null;
  }

  function clearCompletedNativeDrag(event: PointerEvent): void {
    if (event.buttons === 0 && nativeDragFilePath) finishDrag();
  }

  function route(hit: ExplainedSearchHit): DesktopResourceKind {
    return hit.kind === 'Topic' ? 'topic' : hit.kind === 'Workstream' ? 'workstream'
      : hit.kind === 'AgentMessage' ? 'agent-message' : hit.kind === 'TopicType' ? 'topic-type' : 'document';
  }

  async function openHit(hit: ExplainedSearchHit): Promise<void> {
    try {
      await onOpen(route(hit), hit.id);
    } catch (error) { session.error = error instanceof Error ? error.message : String(error); }
  }

  async function search(suggestion?: string): Promise<void> {
    if (session.loading || !session.prompt.trim()) return;
    if (suggestion) session.prompt = `${session.response?.query ?? session.prompt}\nClarification: ${suggestion}`;
    const current = session;
    const query = current.prompt;
    const requestId = crypto.randomUUID();
    current.requestId = requestId;
    current.trace = [];
    session.loading = true;
    session.error = '';
    session.notice = '';
    session.response = null;
    try {
      const response = await window.workingMemory.searchDocuments(query, { requestId, context: current.context });
      if (session === current && current.requestId === requestId) {
        current.response = response;
        current.trace = response.trace ?? current.trace;
      }
    }
    catch (error) {
      if (session === current && current.requestId === requestId) {
        const message = error instanceof Error ? error.message : String(error);
        current.error = current.response ? `AI refinement did not finish: ${message}. Retrieved results remain available.` : message;
      }
    }
    finally {
      if (session === current && current.requestId === requestId) {
        current.loading = false;
        current.requestId = null;
      }
    }
  }

  async function cancel(): Promise<void> {
    if (!session.requestId) return;
    try { await window.workingMemory.cancelDocumentSearch(session.requestId); }
    catch (error) { session.error = error instanceof Error ? error.message : String(error); }
  }

</script>

<svelte:window onpointermove={event => {
  clearCompletedNativeDrag(event); if (event.buttons === 0 && topicDrags?.native) topicDrags.finish();
}} onpointerup={event => {
  clearCompletedNativeDrag(event); if (event.buttons === 0 && topicDrags?.native) topicDrags.finish();
}} />

{#snippet resultRow(hit: ExplainedSearchHit, description: string = '')}
  <SearchResult {hit} kind={hit.kind} {description} {attachmentBaseUrl} {onAddChild} {onAdded}
    topicDrag={topicDrags ?? undefined} href={desktopDeepLink(route(hit), hit.id)} onOpen={() => void openHit(hit)}
    onPrepare={() => resourceDrags.prepare(dragUri(hit), hit.title)}
    onDragStart={event => startDrag(event, hit)} onDragEnd={finishDrag} />
{/snippet}

<section class="search-view" aria-label="Search documents">
  <header>
    <h1><span class="codicon codicon-search" aria-hidden="true"></span> Search</h1>
  </header>
  {#if session.context?.document}
    <p class="context">Scope: {session.context.document.title}
      {#if session.context.workstreams?.length}
        <span> / {session.context.workstreams.map(ws => ws.title).join(', ')}</span>
      {/if}
    </p>
  {/if}
  <form onsubmit={(event) => { event.preventDefault(); void search(); }}>
    <div class="search-input">
      <textarea id="document-search-prompt" aria-label="Search request" aria-describedby="search-compose-help"
        bind:value={session.prompt} maxlength="2000" rows={session.multiline ? 6 : 2}
        placeholder="Describe what you want to find"
        disabled={session.loading}
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.isComposing
            && (event.metaKey || event.ctrlKey || (!session.multiline && !event.shiftKey && !event.altKey))) {
            event.preventDefault();
            if (!event.repeat) void search();
          }
        }}></textarea>
      <button class="compose-toggle" type="button" aria-label="Multiline mode"
        aria-pressed={session.multiline} aria-controls="document-search-prompt"
        title={session.multiline ? 'Switch to Enter-to-search mode' : 'Switch to multiline composition'}
        disabled={session.loading}
        onclick={(event) => {
          session.multiline = !session.multiline;
          event.currentTarget.form?.querySelector('textarea')?.focus();
        }}><span class="codicon codicon-file" aria-hidden="true"></span></button>
    </div>
    <div class="compose-actions">
      <span id="search-compose-help">{session.multiline
        ? 'Enter for a new line; Ctrl/Cmd+Enter to search'
        : 'Enter to search; Shift+Enter for a new line'}</span>
      <button class="primary" type="submit" disabled={session.loading || !session.prompt.trim()}>
        <span class="codicon codicon-{session.loading ? 'loading' : 'sparkle'}" class:codicon-modifier-spin={session.loading} aria-hidden="true"></span>
        {session.loading ? 'Searching...' : 'Search'}
      </button>
      {#if session.loading}<button type="button" onclick={() => void cancel()}>Cancel search</button>{/if}
    </div>
  </form>
  {#if session.loading}<p role="status">{session.response ? 'Results are available. Refining with AI...' : 'Retrieving local matches...'}</p>{/if}
  {#if session.error}<p class="error" role="alert">{session.error} Edit your request or try again.</p>{/if}
  {#if session.notice}<p class="notice" role="status">{session.notice}</p>{/if}
  {#if session.response}
    <section aria-label="Search results">
      <h2>{session.response.blocks ? 'Answer' : `${session.response.results.length} ${session.response.results.length === 1 ? 'match' : 'matches'}`}</h2>
      <p class="searched-for">Results for: {session.response.query}</p>
      {#if session.response.limited && !session.response.blocks}
        <p class="searched-for">Showing top matches from indexed text. Add to your search to narrow the results.</p>
      {/if}
      {#if session.response.partial}
        <p class="notice" role="status">Some source evidence was incomplete. This answer may not be exhaustive.</p>
      {/if}
      {#if session.response.blocks}
        {#each session.response.blocks as block}
          {#if block.type === 'summary'}
            <p class="answer-summary">{block.text}</p>
            <div class="citations">
              {#each block.sourceIds as id}
                {@const hit = sources.get(id)}
                {#if hit}{@render resultRow(hit)}{/if}
              {/each}
            </div>
          {:else if block.type === 'list'}
            {#if block.heading}<h3 class="group-heading">{block.heading}</h3>{/if}
            {#each block.items as item}
              {@const hit = sources.get(item.sourceId)}
              {#if hit}{@render resultRow(hit, item.text)}{/if}
            {/each}
          {:else if block.type === 'table'}
            {#if block.heading}<h3 class="group-heading">{block.heading}</h3>{/if}
            <div class="table-scroll"><table>
              <thead><tr>{#each block.columns as column}<th>{column}</th>{/each}</tr></thead>
              <tbody>{#each block.rows as row}
                {@const hit = sources.get(row.sourceId)}
                {#if hit}<tr data-search-result={hit.id}>
                  {#each block.columns as column}<td>
                    {#if column === 'title'}
                      {@render resultRow(hit)}
                    {:else if column === 'kind'}{hit.kind}
                    {:else if column === 'status'}{hit.status ?? 'Unknown'}
                    {:else}{row.summary}{/if}
                  </td>{/each}
                </tr>{/if}
              {/each}</tbody>
            </table></div>
          {:else if block.type === 'count'}
            <p class="count"><strong>{block.value}</strong> {block.label}</p>
          {:else if block.type === 'clarification'}
            <div class="clarification"><p>{block.text}</p>
              {#each block.suggestions as suggestion}
                <button onclick={() => void search(suggestion)} disabled={session.loading}>{suggestion}</button>
              {/each}
            </div>
          {/if}
        {/each}
      {:else if session.response.results.length === 0}
        <p>No relevant documents found. Try describing the problem differently or including another related concept.</p>
      {:else}
        {#each session.response.results as hit (hit.id)}{@render resultRow(hit, hit.reason)}{/each}
      {/if}
    </section>
  {/if}
  {#if session.trace.length}
    <details class="search-trace"><summary>Read-only activity ({session.trace.filter(entry => entry.stage !== 'ai').length} calls; {session.trace.filter(entry => entry.stage === 'ai').length} AI turns)</summary>
      <ol>{#each session.trace as entry}
        <li class:error={entry.status === 'error'}>{entry.tool}: {entry.status}
          {entry.count === undefined ? '' : ` (${entry.count} items)`} / {entry.durationMs}ms
          {#if entry.error}<span>{entry.error}</span>{/if}
          {#if entry.timings}
            <p class="stage-timings">Startup: {entry.timings.startupMs === undefined ? 'unavailable' : `${entry.timings.startupMs.toFixed(0)} ms`}
              &middot; Inference: {entry.timings.inferenceMs.toFixed(0)} ms
              &middot; Ranking: {entry.timings.rankingMs.toFixed(0)} ms
              &middot; Host round trip: {entry.timings.hostMs.toFixed(0)} ms</p>
          {/if}
          <pre>{JSON.stringify(entry.arguments, null, 2)}</pre>
        </li>
      {/each}</ol>
    </details>
  {/if}
</section>

<style>
  .search-view { padding: 12px 16px 16px; color: var(--vscode-foreground); }
  h1 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 21px; }
  h1 .codicon { font-size: 24px; }
  .context, .searched-for { color: var(--vscode-descriptionForeground); margin: 6px 0; font-size: 12px; }
  p { line-height: 1.5; overflow-wrap: anywhere; }
  form { display: grid; gap: 8px; }
  form { margin: 10px 0; }
  .search-input { position: relative; }
  .search-input textarea { display: block; padding-right: 58px; }
  .compose-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  #search-compose-help { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .compose-actions .primary { margin-left: auto; }
  .compose-toggle { position: absolute; top: 8px; right: 20px; display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #475569; box-shadow: 0 1px 2px #0f172a14; cursor: pointer; }
  .compose-toggle[aria-pressed="true"] { background: #475569; color: #fff; border-color: #475569; }
  .compose-toggle:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  textarea { box-sizing: border-box; width: 100%; padding: 10px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 5px; font: inherit; }
  textarea { resize: vertical; min-height: 56px; }
  textarea:focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button { padding: 7px 12px; border: 1px solid var(--vscode-input-border); border-radius: 4px; background: transparent; color: inherit; }
  button:disabled { opacity: .6; cursor: default; }
  .primary { justify-self: end; display: flex; align-items: center; gap: 7px; color: var(--desktop-accent-strong); border-color: var(--desktop-accent-strong); }
  .primary:hover:not(:disabled) { background: var(--desktop-accent-soft); }
  .citations { display: grid; gap: 4px; }
  h2 { margin: 12px 0 6px; font-size: 16px; }
  h3 { margin: 0; font-size: 14px; }
  .group-heading { margin: 10px 0 6px; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border); }
  th { text-transform: capitalize; }
  .clarification button { margin: 0 6px 6px 0; }
  .search-trace { margin-top: 10px; font-size: 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  .error { color: var(--vscode-errorForeground); }
  .notice { padding: 10px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
</style>
