<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import type { ExplainedSearchHit, SearchWorkstream } from '../../../../shared/documentSearch';
  import type { DesktopResourceKind } from '../../shared/contracts';
  import { desktopDeepLink } from '../../shared/deepLink';
  import type { SearchViewState } from '../documentSearch';
  import { ResourceDragPreparationCache, setResourceDragData, type ActiveResourceDrag } from '../resourceDrag';

  let { state: session = $bindable(), activeDrag = $bindable(null), onOpen, onOpenApp, onAdded }: {
    state: SearchViewState;
    activeDrag?: ActiveResourceDrag | null;
    onOpen: (kind: DesktopResourceKind, id: string) => void | Promise<void>;
    onOpenApp?: (id: string) => void | Promise<void>;
    onAdded: () => void | Promise<void>;
  } = $props();
  let selected = $state<ExplainedSearchHit | null>(null);
  let workstreams = $state<SearchWorkstream[]>([]);
  let workstreamId = $state('');
  let loadingWorkstreams = $state(false);
  let adding = $state(false);
  let actionError = $state('');
  let dialog = $state<HTMLDialogElement>(null!);
  const sources = $derived(new Map(session.response?.results.map(hit => [hit.id, hit]) ?? []));
  const resourceDrags = new ResourceDragPreparationCache(
    (openUri, label) => window.workingMemory.prepareResourceDrag(openUri, label),
    error => { session.error = `Unable to prepare drag context: ${error instanceof Error ? error.message : String(error)}`; },
  );
  let nativeDragFilePath: string | null = null;
  let ownedDrag: ActiveResourceDrag | null = null;

  onMount(() => {
    const stopTrace = window.workingMemory.onDocumentSearchTrace(({ requestId, trace }) => {
      if (session.requestId === requestId) session.trace = [...session.trace, trace];
    });
    const stopDrag = window.workingMemory.onResourceDragResult(result => {
      if (result.filePath !== nativeDragFilePath || result.status !== 'failed') return;
      finishDrag();
      session.error = `Unable to drag Working Memory context: ${result.error ?? 'Native drag failed.'}`;
    });
    return () => { stopTrace(); stopDrag(); };
  });
  $effect(() => {
    session.response;
    resourceDrags.clear();
  });
  onDestroy(() => { resourceDrags.clear(); finishDrag(); });

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
      if (hit.appId) {
        if (!onOpenApp) throw new Error('Application navigation is unavailable.');
        await onOpenApp(hit.appId);
      } else await onOpen(route(hit), hit.id);
    } catch (error) { session.error = error instanceof Error ? error.message : String(error); }
  }

  async function search(suggestion?: string): Promise<void> {
    if (session.loading || !session.prompt.trim()) return;
    if (suggestion) session.prompt = `${session.response?.query ?? session.prompt}\nClarification: ${suggestion}`;
    const current = session;
    const requestId = crypto.randomUUID();
    current.requestId = requestId;
    current.trace = [];
    session.loading = true;
    session.error = '';
    session.notice = '';
    session.response = null;
    try {
      const response = await window.workingMemory.searchDocuments(current.prompt, { requestId, context: current.context });
      if (session === current && current.requestId === requestId) {
        current.response = response;
        current.trace = response.trace ?? current.trace;
      }
    }
    catch (error) {
      if (session === current && current.requestId === requestId) current.error = error instanceof Error ? error.message : String(error);
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

  async function chooseWorkstream(hit: ExplainedSearchHit): Promise<void> {
    selected = hit;
    workstreams = [];
    workstreamId = '';
    actionError = '';
    loadingWorkstreams = true;
    await tick();
    dialog.showModal();
    try { workstreams = await window.workingMemory.listSearchWorkstreams(); }
    catch (error) { actionError = error instanceof Error ? error.message : String(error); }
    finally { loadingWorkstreams = false; }
  }

  async function add(): Promise<void> {
    if (!selected || !workstreamId || adding) return;
    adding = true;
    actionError = '';
    try {
      await window.workingMemory.addSearchTopicToWorkstream(selected.id, workstreamId);
      session.notice = `Added "${selected.title}" to "${workstreams.find(ws => ws.id === workstreamId)?.title ?? workstreamId}".`;
      dialog.close();
      selected = null;
      try { await onAdded(); }
      catch (error) {
        session.error = `The topic was added, but refreshing failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    } catch (error) { actionError = error instanceof Error ? error.message : String(error); }
    finally { adding = false; }
  }
</script>

<svelte:window onpointermove={clearCompletedNativeDrag} onpointerup={clearCompletedNativeDrag} />

{#snippet sourceLink(hit: ExplainedSearchHit)}
  {#if hit.appId}
    <button class="source-link" onclick={() => void openHit(hit)}>{hit.title}</button>
  {:else}
    <a href={desktopDeepLink(route(hit), hit.id)} draggable="true"
      onpointerenter={() => resourceDrags.prepare(dragUri(hit), hit.title)}
      onpointerdown={() => resourceDrags.prepare(dragUri(hit), hit.title)}
      onfocus={() => resourceDrags.prepare(dragUri(hit), hit.title)}
      ondragstart={event => startDrag(event, hit)} ondragend={finishDrag}
      onclick={(event) => { event.preventDefault(); void openHit(hit); }}>{hit.title}</a>
  {/if}
{/snippet}

{#snippet card(hit: ExplainedSearchHit, description: string)}
  <article data-search-result={hit.id}>
    <div class="result-heading"><span class="kind">{hit.kind}</span><h3>{@render sourceLink(hit)}</h3>
      {#if hit.status}<span class="kind">{hit.status}</span>{/if}</div>
    <p class="reason">{description}</p>
    {#if hit.kind === 'Topic'}
      <footer>
        <button onclick={() => void chooseWorkstream(hit)}>Add to workstream</button>
      </footer>
    {/if}
  </article>
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
        {session.loading ? 'Searching...' : 'Find with AI'}
      </button>
      {#if session.loading}<button type="button" onclick={() => void cancel()}>Cancel search</button>{/if}
    </div>
  </form>
  {#if session.loading}<p role="status">Querying read-only tools and preparing a grounded answer...</p>{/if}
  {#if session.error}<p class="error" role="alert">{session.error} Edit your request or try again.</p>{/if}
  {#if session.notice}<p class="notice" role="status">{session.notice}</p>{/if}
  {#if session.response}
    <section aria-label="Search results">
      <h2>{session.response.blocks ? 'Answer' : `${session.response.results.length} ${session.response.results.length === 1 ? 'match' : 'matches'}`}</h2>
      <p class="searched-for">Results for: {session.response.query}</p>
      {#if session.response.partial}
        <p class="notice" role="status">Partial evidence: some pages, document text or application data were not read, or a tool failed. This answer may not be exhaustive.</p>
      {/if}
      {#if session.response.blocks}
        {#each session.response.blocks as block}
          {#if block.type === 'summary'}
            <p class="answer-summary">{block.text}</p>
            <div class="citations">
              {#each block.sourceIds as id}
                {@const hit = sources.get(id)}
                {#if hit}{@render sourceLink(hit)}
                  {#if hit.kind === 'Topic'}<button onclick={() => void chooseWorkstream(hit)}>Add to workstream</button>{/if}
                {/if}
              {/each}
            </div>
          {:else if block.type === 'list'}
            {#if block.heading}<h3 class="group-heading">{block.heading}</h3>{/if}
            {#each block.items as item}
              {@const hit = sources.get(item.sourceId)}
              {#if hit?.appId}
                <div class="app-result" data-search-result={hit.id}><p>{item.text}</p>{@render sourceLink(hit)}</div>
              {:else if hit}{@render card(hit, item.text)}{/if}
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
                      {@render sourceLink(hit)}
                      {#if hit.kind === 'Topic'}<button onclick={() => void chooseWorkstream(hit)}>Add to workstream</button>{/if}
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
        {#each session.response.results as hit (hit.id)}{@render card(hit, hit.reason)}{/each}
      {/if}
    </section>
  {/if}
  {#if session.trace.length}
    <details class="search-trace"><summary>Read-only activity ({session.trace.length} calls)</summary>
      <ol>{#each session.trace as entry}
        <li class:error={entry.status === 'error'}>{entry.tool}: {entry.status}
          {entry.count === undefined ? '' : ` (${entry.count} items)`} / {entry.durationMs}ms
          {#if entry.error}<span>{entry.error}</span>{/if}
          <pre>{JSON.stringify(entry.arguments, null, 2)}</pre>
        </li>
      {/each}</ol>
    </details>
  {/if}
</section>

{#if selected}
  <dialog bind:this={dialog} aria-labelledby="search-add-title" closedby={adding ? 'none' : 'closerequest'}
    oncancel={(event) => { event.preventDefault(); if (!adding) { dialog.close(); selected = null; } }}>
    <h2 id="search-add-title">Add to workstream</h2>
    <p>{selected.title}</p>
    <p>Adds membership without moving the topic, changing its status or removing existing memberships.</p>
    {#if loadingWorkstreams}
      <p role="status">Loading open workstreams...</p>
    {:else if workstreams.length > 0}
      <label>Open workstream
        <select bind:value={workstreamId} disabled={adding}>
          <option value="">Choose a workstream</option>
          {#each workstreams as ws (ws.id)}<option value={ws.id}>{ws.title}</option>{/each}
        </select>
      </label>
    {:else if !actionError}<p>No open workstreams are available.</p>{/if}
    {#if actionError}<p class="error" role="alert">{actionError}</p>{/if}
    <footer>
      <button onclick={() => { dialog.close(); selected = null; }} disabled={adding}>Cancel</button>
      {#if actionError && !workstreams.length}
        <button onclick={() => { dialog.close(); void chooseWorkstream(selected!); }}>Retry loading</button>
      {/if}
      <button class="primary" onclick={() => void add()} disabled={adding || loadingWorkstreams || !workstreamId}>
        {adding ? 'Adding...' : 'Add'}
      </button>
    </footer>
  </dialog>
{/if}

<style>
  .search-view { padding: 12px 16px 16px; color: var(--vscode-foreground); }
  h1 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 21px; }
  h1 .codicon { font-size: 24px; }
  .context, .searched-for { color: var(--vscode-descriptionForeground); margin: 6px 0; font-size: 12px; }
  p { line-height: 1.5; overflow-wrap: anywhere; }
  form, label { display: grid; gap: 8px; }
  form { margin: 10px 0; }
  .search-input { position: relative; }
  .search-input textarea { display: block; padding-right: 58px; }
  .compose-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  #search-compose-help { color: var(--vscode-descriptionForeground); font-size: 12px; }
  .compose-actions .primary { margin-left: auto; }
  .compose-toggle { position: absolute; top: 8px; right: 20px; display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 1px solid #cbd5e1; border-radius: 4px; background: #fff; color: #475569; box-shadow: 0 1px 2px #0f172a14; cursor: pointer; }
  .compose-toggle[aria-pressed="true"] { background: #475569; color: #fff; border-color: #475569; }
  .compose-toggle:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
  textarea, select { box-sizing: border-box; width: 100%; padding: 10px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-radius: 5px; font: inherit; }
  textarea { resize: vertical; min-height: 56px; }
  textarea:focus, select:focus { outline: 2px solid var(--vscode-focusBorder); outline-offset: 1px; }
  button { padding: 7px 12px; border: 1px solid var(--vscode-input-border); border-radius: 4px; background: transparent; color: inherit; }
  button:disabled { opacity: .6; cursor: default; }
  .primary { justify-self: end; display: flex; align-items: center; gap: 7px; color: var(--desktop-accent-strong); border-color: var(--desktop-accent-strong); }
  .primary:hover:not(:disabled) { background: var(--desktop-accent-soft); }
  article { padding: 8px 10px; margin: 6px 0; border: 1px solid var(--vscode-widget-border); border-radius: 5px; background: var(--vscode-editor-background); }
  .result-heading, .citations { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
  h2 { margin: 12px 0 6px; font-size: 16px; }
  h3 { margin: 0; font-size: 14px; }
  .reason { margin: 4px 0; font-size: 13px; }
  .group-heading { margin: 10px 0 6px; }
  .app-result { display: flex; gap: 10px; align-items: baseline; padding: 5px 0; border-bottom: 1px solid var(--vscode-widget-border); font-size: 13px; }
  .app-result p { flex: 1; margin: 0; }
  .source-link { padding: 0; border: 0; color: var(--vscode-textLink-foreground); font: inherit; text-align: left; cursor: pointer; }
  .source-link:hover { text-decoration: underline; }
  .table-scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--vscode-widget-border); }
  th { text-transform: capitalize; }
  td button, .citations button { padding: 2px 6px; font-size: 11px; margin-left: 6px; }
  .clarification button { margin: 0 6px 6px 0; }
  .search-trace { margin-top: 10px; font-size: 12px; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { color: var(--vscode-textLink-foreground); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .kind { color: var(--vscode-descriptionForeground); font-size: 12px; }
  footer { display: flex; align-items: start; justify-content: flex-end; gap: 10px; margin-top: 4px; }
  article footer button { padding: 3px 7px; font-size: 12px; }
  .error { color: var(--vscode-errorForeground); }
  .notice { padding: 10px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
  dialog { width: min(460px, 85vw); padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; }
  dialog::backdrop { background: #0006; }
  dialog h2 { margin-top: 0; }
</style>
