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
  import {
    shouldRequestTopicAutocomplete,
    TOPIC_AUTOCOMPLETE_IDLE_MS,
  } from '../topicAutocomplete';

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
  let titleAuthored = false;
  let typeAuthored = false;
  let lastRequestedAt = 0;
  let lastSuggestedBody = '';
  let autocompleteTimer: number | undefined;
  let autocompleteGeneration = 0;

  const relation = (slug: string, title: string): RelationVM => ({
    slug,
    title,
    alertCount: 0,
    alertSeverity: null,
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
    workstreams: [relation(draft.workstream, draft.workstreamTitle)],
    focusedWorkstreams: [],
    alerts: [],
  });

  function updateDraft(patch: TopicPatch): void {
    if (patch.title !== undefined) {
      titleAuthored = true;
      draft.title = patch.title;
    }
    if (patch.body !== undefined) {
      draft.body = patch.body;
      scheduleAutocomplete();
    }
    if (patch.topicType !== undefined) {
      typeAuthored = true;
      draft.topicType = patch.topicType;
    }
  }

  function scheduleAutocomplete(): void {
    if (autocompleteTimer !== undefined) window.clearTimeout(autocompleteTimer);
    if (!shouldRequestTopicAutocomplete({
      body: draft.body,
      lastSuggestedBody,
      lastRequestedAt,
      now: Date.now(),
    })) return;
    autocompleteTimer = window.setTimeout(() => void requestAutocomplete(), TOPIC_AUTOCOMPLETE_IDLE_MS);
  }

  async function requestAutocomplete(): Promise<void> {
    autocompleteTimer = undefined;
    const body = draft.body;
    const generation = ++autocompleteGeneration;
    lastRequestedAt = Date.now();
    lastSuggestedBody = body;
    autocompleteStatus = 'Suggesting title and type...';
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
      });
      if (generation !== autocompleteGeneration) return;
      if (!titleAuthored) draft.title = suggestion.title;
      if (!typeAuthored) draft.topicType = suggestion.topicType;
      autocompleteStatus = 'Title and type suggested';
    } catch (reason) {
      if (generation !== autocompleteGeneration) return;
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
    onSetAlertStatus={() => {}}
    {attachmentBaseUrl}
    {onAttachImages}
    titlePlaceholder="New Topic"
    draft
  />

  {#if error}
    <p class="create-error" role="alert">{error}</p>
  {/if}
  {#if autocompleteStatus}
    <p class="autocomplete-status" role="status">{autocompleteStatus}</p>
  {/if}

  <div class="create-action">
    <button disabled={creating} onclick={() => void create()}>
      {creating ? 'Creating...' : 'Create Topic'}
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
