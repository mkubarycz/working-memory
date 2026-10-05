<script lang="ts">
  import type { AttachmentRef, TopicCreateDraftVM } from './types';
  import HybridMarkdownEditor from './HybridMarkdownEditor.svelte';

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

  async function create(): Promise<void> {
    if (creating) return;
    error = '';
    if (!draft.title.trim()) {
      error = 'Enter a topic title.';
      return;
    }
    if (!draft.topicType) {
      error = 'Select a topic type.';
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

<header class="head">
  <span aria-hidden="true" class="type-icon codicon codicon-add"></span>
  <input
    class="title-input"
    bind:value={draft.title}
    aria-label="Topic title"
    placeholder="New topic title"
    disabled={creating}
  />
  <button class="create-button" disabled={creating} onclick={() => void create()}>
    {creating ? 'Creating...' : 'Create'}
  </button>
</header>

<section class="attrs" aria-label="New topic attributes">
  <label>
    <span>Topic type</span>
    <select bind:value={draft.topicType} aria-label="Topic type" disabled={creating || draft.topicTypes.length === 0}>
      <option value="">Select a type...</option>
      {#each draft.topicTypes as topicType (topicType.slug)}
        <option value={topicType.slug ?? ''}>{topicType.label}</option>
      {/each}
    </select>
  </label>
  <div>
    <span>Workstream</span>
    <strong>{draft.workstreamTitle}</strong>
  </div>
  {#if draft.parent}
    <div>
      <span>Parent</span>
      <strong>{draft.parentTitle ?? draft.parent}</strong>
    </div>
  {/if}
</section>

{#if error}
  <p class="error" role="alert">{error}</p>
{/if}

<section class="body">
  <h2>Content</h2>
  <HybridMarkdownEditor
    value={draft.body}
    {attachmentBaseUrl}
    onInput={(value) => (draft.body = value)}
    {onAttachImages}
  />
</section>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .type-icon {
    font-size: 20px;
  }

  .title-input {
    flex: 1;
    min-width: 0;
    padding: 5px 8px;
    color: var(--vscode-input-foreground);
    font-size: 1.5em;
    font-weight: 600;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }

  .title-input:focus,
  select:focus {
    outline: 1px solid var(--vscode-focusBorder);
  }

  .create-button {
    padding: 6px 14px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: 0;
    border-radius: 4px;
    cursor: pointer;
  }

  .create-button:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }

  .create-button:disabled {
    opacity: 0.65;
    cursor: default;
  }

  .attrs {
    display: flex;
    flex-wrap: wrap;
    gap: 16px 28px;
    padding: 12px 14px;
    border: 1px solid var(--vscode-widget-border);
    border-radius: 6px;
  }

  .attrs label,
  .attrs div {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }

  .attrs span {
    color: var(--vscode-descriptionForeground);
    font-size: 0.78em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  select {
    min-width: 180px;
    padding: 4px 7px;
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 4px;
  }

  .error {
    margin: 0;
    padding: 8px 10px;
    color: var(--vscode-errorForeground);
    background: color-mix(in srgb, var(--vscode-errorForeground) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--vscode-errorForeground) 35%, transparent);
    border-radius: 4px;
  }

  .body {
    display: grid;
    min-height: 320px;
    gap: 8px;
  }

  .body h2 {
    margin: 0;
    font-size: 0.9em;
    font-weight: 600;
  }
</style>
