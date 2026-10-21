<script lang="ts">
  import { onDestroy } from 'svelte';
  import type {
    AttachmentRef,
    RelationVM,
    TopicCreateDraftVM,
    TopicPatch,
    TopicVM,
  } from './types';
  import TopicView from './TopicView.svelte';
  import { topicAutocompleteDelay } from '../topicAutocomplete';

  interface Props {
    draft: TopicCreateDraftVM;
    attachmentBaseUrl?: string;
    onAttachImages?: (files: File[]) => Promise<AttachmentRef[]>;
    onCreate: () => Promise<void>;
  }

  let {
    draft,
    attachmentBaseUrl = '',
    onAttachImages = async () => [],
    onCreate,
  }: Props = $props();

  let creating = $state(false);
  let error = $state('');
  let autocompleteStatus = $state('');
  let autocompleteError = $state(false);
  let titleAuthored = false;
  let typeAuthored = false;
  let workstreamTitleAuthored = false;
  let lastRequestedAt = 0;
  let lastSuggestedBody = '';
  let autocompleteTimer: number | undefined;
  let autocompleteGeneration = 0;
  const creatingWorkstream = $derived(draft.newWorkstreamTitle !== undefined && !draft.workstream);

  const relation = (slug: string, title: string): RelationVM => ({
    slug,
    title,
    agentMessageCount: 0,
    agentMessageSeverity: null,
  });

  const topic = $derived<TopicVM>({
    kind: 'topic',
    title: draft.title,
    slug: null,
    status: 'open',
    topicType: draft.topicType,
    typeMeta: draft.topicTypes.find((candidate) => candidate.slug === draft.topicType) ?? null,
    topicTypes: draft.topicTypes,
    body: draft.body,
    createdAt: 0,
    updatedAt: 0,
    resourceVersion: 0,
    editable: true,
    parents: draft.parent ? [relation(draft.parent, draft.parentTitle ?? draft.parent)] : [],
    children: [],
    workstreams: draft.workstream ? [relation(draft.workstream, draft.workstreamTitle)] : [],
    focusedWorkstreams: [],
    agentMessages: [],
  });

  function updateDraft(patch: TopicPatch): void {
    if (patch.title !== undefined) {
      titleAuthored = true;
      draft.title = patch.title;
    }
    if (patch.body !== undefined) {
      draft.body = patch.body;
      autocompleteGeneration += 1;
      scheduleAutocomplete();
    }
    if (patch.topicType !== undefined) {
      typeAuthored = true;
      draft.topicType = patch.topicType;
    }
  }

  function scheduleAutocomplete(retry = false): void {
    if (autocompleteTimer !== undefined) window.clearTimeout(autocompleteTimer);
    const delay = topicAutocompleteDelay({
      body: draft.body,
      lastSuggestedBody: retry ? '' : lastSuggestedBody,
      lastRequestedAt,
      now: Date.now(),
    });
    autocompleteError = false;
    autocompleteStatus = '';
    if (delay === null) return;
    autocompleteStatus = 'Waiting to suggest titles and type...';
    autocompleteTimer = window.setTimeout(() => void requestAutocomplete(), delay);
  }

  async function requestAutocomplete(): Promise<void> {
    autocompleteTimer = undefined;
    const body = draft.body;
    const generation = ++autocompleteGeneration;
    lastRequestedAt = Date.now();
    autocompleteError = false;
    autocompleteStatus = creatingWorkstream ? 'Suggesting titles and type...' : 'Suggesting title and type...';
    try {
      const suggestion = await window.workingMemory.autocompleteTopic({
        body,
        currentTitle: draft.title,
        currentTopicType: draft.topicType,
        topicTypes: draft.topicTypes.map(({ slug, label, description }) => ({
          slug: slug ?? '',
          label,
          description,
        })),
        ...(creatingWorkstream ? { currentWorkstreamTitle: draft.newWorkstreamTitle } : {}),
      });
      if (generation !== autocompleteGeneration) return;
      lastSuggestedBody = body;
      if (!titleAuthored) draft.title = suggestion.title;
      if (!typeAuthored) draft.topicType = suggestion.topicType;
      if (creatingWorkstream && !workstreamTitleAuthored && suggestion.workstreamTitle !== undefined) {
        draft.newWorkstreamTitle = suggestion.workstreamTitle;
      }
      autocompleteStatus = creatingWorkstream ? 'Titles and type suggested' : 'Title and type suggested';
    } catch (reason) {
      if (generation !== autocompleteGeneration) return;
      autocompleteError = true;
      autocompleteStatus = reason instanceof Error ? reason.message : String(reason);
    }
  }

  onDestroy(() => {
    if (autocompleteTimer !== undefined) window.clearTimeout(autocompleteTimer);
    autocompleteGeneration += 1;
  });

  async function create(): Promise<void> {
    if (creating) return;
    error = '';
    if (!draft.title.trim()) {
      error = 'Enter a topic title.';
      return;
    }
    if (creatingWorkstream && !draft.newWorkstreamTitle?.trim()) {
      error = 'Enter a workstream title.';
      return;
    }
    creating = true;
    try {
      await onCreate();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally {
      creating = false;
    }
  }
</script>

<div class="create-view">
  <TopicView
    {topic}
    saveState="idle"
    onSaveTopic={updateDraft}
    onOpenTopic={() => {}}
    onOpenWorkstream={() => {}}
    onSetAgentMessageStatus={() => {}}
    {attachmentBaseUrl}
    {onAttachImages}
    titlePlaceholder="New Topic"
    newWorkstreamTitle={creatingWorkstream ? draft.newWorkstreamTitle : undefined}
    onNewWorkstreamTitleChange={(title) => {
      workstreamTitleAuthored = true;
      draft.newWorkstreamTitle = title;
    }}
    draft
  />

  {#if error}
    <p class="create-error" role="alert">{error}</p>
  {/if}
  {#if autocompleteStatus}
    <p class="autocomplete-status" role={autocompleteError ? 'alert' : 'status'}>
      {autocompleteStatus}
      {#if autocompleteError}
        <button type="button" onclick={() => scheduleAutocomplete(true)}>Retry suggestions</button>
      {/if}
    </p>
  {/if}

  <div class="create-action">
    <button disabled={creating} onclick={() => void create()}>
      {creating ? 'Creating...' : creatingWorkstream ? 'Create Workstream & Topic' : 'Create Topic'}
    </button>
  </div>
</div>

<style>
  .create-view {
    min-height: 100%;
    padding-bottom: 72px;
  }

  .create-error {
    position: sticky;
    bottom: 70px;
    z-index: 4;
    width: fit-content;
    max-width: min(520px, 100%);
    margin: 12px 0 0 auto;
    padding: 8px 10px;
    color: var(--vscode-errorForeground);
    background: var(--vscode-editor-background);
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 45%, transparent);
    border-radius: 4px;
  }

  .autocomplete-status {
    margin: 8px 0 0;
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    text-align: right;
  }

  .create-action {
    position: sticky;
    bottom: 14px;
    z-index: 3;
    display: flex;
    justify-content: flex-end;
    margin-top: 16px;
    pointer-events: none;
  }

  .create-action button {
    min-width: 132px;
    padding: 9px 18px;
    color: var(--vscode-button-foreground);
    font-weight: 700;
    background: #e93788;
    border: 0;
    border-radius: 6px;
    box-shadow: 0 5px 18px rgba(0, 0, 0, 0.28);
    cursor: pointer;
    pointer-events: auto;
  }

  .create-action button:hover:not(:disabled) {
    background: #f04b98;
  }

  .create-action button:disabled {
    opacity: 0.65;
    cursor: default;
  }
</style>
