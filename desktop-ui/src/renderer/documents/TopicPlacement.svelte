<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { TopicPlacement } from '../../../../control-plane/src/topicPlacementContract';
  import type { SearchBugReportInput } from '../../shared/contracts';
  import ReportBugDialog from '../ReportBugDialog.svelte';
  import PopupFrame from '../PopupFrame.svelte';
  import TopicLink from './TopicLink.svelte';
  import { placementApplyInput, placementBugContext } from './topicPlacementActions';
  import { useSessionBugReportOperation } from '../sessionBugReportOperation';

  let { id, title, resourceVersion, editable, autoLoad = false, environment = '', saved = true,
    onOpenTopic, onOpenWorkstream, onBeforeApply, onApplied, onClose }: {
    id: string; title: string; resourceVersion: number; editable: boolean;
    autoLoad?: boolean; environment?: string; saved?: boolean;
    onOpenTopic: (id: string) => void; onOpenWorkstream: (id: string) => void;
    onApplied?: () => Promise<void>;
    onBeforeApply?: (id: string) => void;
    onClose?: () => void;
  } = $props();
  let result = $state<TopicPlacement | null>(null);
  const selected = $derived(result?.state === 'ready' ? result.suggestions[0] ?? null : null);
  let loading = $state(false);
  let applying = $state(false);
  let error = $state('');
  let notice = $state('');
  let reporting = $state<SearchBugReportInput['search'] | null>(null);
  let generation = 0;
  useSessionBugReportOperation(() => result || loading || error
    ? { kind: 'placement', search: $state.snapshot(placementBugContext({ id, title, resourceVersion }, result, selected, error, loading)) }
    : null);
  $effect(() => {
    void id; void resourceVersion; void environment; void saved;
    const automatic = autoLoad && saved;
    const current = ++generation;
    untrack(() => { result = null; error = ''; notice = ''; loading = false; applying = false; });
    const timer = automatic ? setTimeout(() => {
      if (current === generation) void suggest();
    }, 0) : undefined;
    return () => { generation++; clearTimeout(timer); };
  });
  onDestroy(() => { generation++; });

  async function suggest(): Promise<void> {
    if (loading || applying) return;
    const current = ++generation;
    const topicId = id;
    const version = resourceVersion;
    const sourceEnvironment = environment;
    const automatic = autoLoad;
    const sourceSaved = saved;
    const isCurrent = () => current === generation && id === topicId && resourceVersion === version
      && environment === sourceEnvironment && autoLoad === automatic && saved === sourceSaved;
    loading = true; error = ''; notice = ''; result = null;
    try {
      const value = await window.workingMemory.suggestTopicPlacement(topicId);
      if (isCurrent()) {
        if (value.sourceVersion !== version) throw new Error('The topic changed. Refresh it and suggest placement again.');
        result = value;
      }
    } catch (cause) {
      if (isCurrent()) error = cause instanceof Error ? cause.message : String(cause);
    } finally { if (isCurrent()) loading = false; }
  }

  async function apply(): Promise<void> {
    if (!result || !selected || applying || !editable || !saved) return;
    const current = generation;
    const topicId = id;
    const version = resourceVersion;
    const sourceEnvironment = environment;
    const input = placementApplyInput(topicId, result, selected);
    applying = true; error = '';
    try {
      onBeforeApply?.(topicId);
      await window.workingMemory.applyTopicPlacement(input);
      if (current !== generation || id !== topicId || resourceVersion !== version || environment !== sourceEnvironment) return;
      result = null;
      notice = 'Placement applied. Existing relationships and topic status were preserved.';
      await onApplied?.();
    } catch (cause) {
      if (current === generation) error = cause instanceof Error ? cause.message : String(cause);
    } finally { if (current === generation) applying = false; }
  }
  function report(): void {
    reporting = $state.snapshot(placementBugContext({ id, title, resourceVersion }, result, selected, error, loading));
  }
</script>

{#snippet placementActions()}
      <button class="placement-action-button" aria-label="Refresh" disabled={loading || applying || !saved} onclick={suggest} title="Refresh placement suggestions">
        <span class="codicon codicon-refresh" class:codicon-modifier-spin={loading} aria-hidden="true"></span>
      </button>
      <button class="placement-action-button" disabled={!selected || applying || !editable || !saved} onclick={apply}
        aria-label={applying ? 'Applying placement' : 'Apply'}
        title="Apply the suggested placement without removing existing relationships or moving descendants">
        <span class="codicon codicon-check" aria-hidden="true"></span>
      </button>
      <button class="placement-action-button" onclick={report} aria-label="Bug Report" title="Bug Report">
        <span class="codicon codicon-bug" aria-hidden="true"></span>
      </button>
{/snippet}

<PopupFrame class="topic-placement" title="Placement suggestion" label="Topic placement"
  actions={placementActions} {onClose} closeLabel="Close placement suggestions">
  {#if loading}<p role="status">Suggesting placement…</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if result?.state === 'disabled'}
    <p role="status">Search and Embeddings must be enabled in Settings &gt; Features.</p>
  {:else if result?.state === 'pending'}
    <p role="status">Placement suggestions are waiting for indexing. Refresh when ready.</p>
  {:else if result?.state === 'ready'}
    {#if selected}
      <article>
        <div class="placement-relation">
          <span class="relation-label">Parent</span>
          {#if selected.parent}<TopicLink topic={selected.parent} onOpen={onOpenTopic} />
          {:else}<span>No new parent recommended</span>{/if}
        </div>
        <div class="placement-relation">
          <span class="relation-label">Workstream</span>
          <button class="ws-chip" title={selected.workstream.title} onclick={() => onOpenWorkstream(selected!.workstream.id)}>
            <span aria-hidden="true" class="codicon codicon-briefcase"></span>
            <span class="ws-chip-title">{selected.workstream.title}</span>
          </button>
        </div>
      </article>
    {:else}<p>No sufficiently similar eligible placement found. You can place the topic manually.</p>{/if}
  {/if}
</PopupFrame>

{#if reporting}
  <ReportBugDialog onClose={() => { reporting = null; }}
    supportingEvidence={reporting.supportingEvidence}
    evidenceDescription="The report includes the displayed supporting evidence, source topic, selected parent and workstream, captured versions, readiness and errors."
    capture={description => window.workingMemory.createSearchBugReport({ description, search: $state.snapshot(reporting!) })} />
{/if}

<style>
  article { margin-top: 8px; }
  p { margin: 8px 0 0; font-size: 0.9em; }
  .placement-relation { display: flex; align-items: center; gap: 8px; margin: 8px 0; min-width: 0; }
  .relation-label { min-width: 104px; color: var(--desktop-chat-muted); font-size: 0.85em; }
  .ws-chip {
    display: flex; align-items: center; gap: 6px; max-width: 100%; min-width: 0;
    text-align: left; padding: 2px 6px; border: none; border-radius: 4px; background: transparent;
    color: var(--vscode-textLink-foreground); cursor: pointer; font-size: 0.95em;
  }
  .ws-chip:hover { background: var(--vscode-list-hoverBackground); text-decoration: underline; }
  .ws-chip:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .ws-chip-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
