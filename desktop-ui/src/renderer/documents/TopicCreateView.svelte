<script lang="ts">
  import type {
    AttachmentRef,
    RelationVM,
    TopicCreateDraftVM,
    TopicPatch,
    TopicVM,
  } from './types';
  import TopicView from './TopicView.svelte';

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
    if (patch.title !== undefined) draft.title = patch.title;
    if (patch.body !== undefined) draft.body = patch.body;
    if (patch.topicType !== undefined) draft.topicType = patch.topicType;
  }

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
