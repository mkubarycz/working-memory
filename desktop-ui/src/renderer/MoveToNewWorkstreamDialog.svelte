<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import type { TopicDragSource, TopicTransferRequest, NewWorkstreamMoveDraft } from './topicTransfer';
  import { moveTopicToNewWorkstream } from './topicTransfer';

  let { source, beforeMove, onMove, onClose }: {
    source: TopicDragSource;
    beforeMove: () => Promise<void>;
    onMove: (request: TopicTransferRequest) => Promise<void>;
    onClose: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  let draft = $state<NewWorkstreamMoveDraft>({ slug: '', sourceWorkstream: '', title: '', targetWorkstream: '' });
  let topicTitle = $state('');
  let suggesting = $state(false);
  let moving = $state(false);
  let authored = false;
  let generation = 0;
  let error = $state('');
  let suggestionError = $state('');

  onMount(() => {
    draft.slug = source.slug;
    draft.sourceWorkstream = source.sourceWorkstream;
    dialog.showModal();
    void suggestName();
  });
  onDestroy(() => { generation += 1; });

  async function suggestName(): Promise<void> {
    const request = ++generation;
    suggesting = true;
    suggestionError = '';
    try {
      await beforeMove();
      const topic = await window.workingMemory.openResource('topic', source.slug);
      if (request !== generation) return;
      if (topic.kind !== 'topic') throw new Error('The selected resource is not a topic.');
      topicTitle = topic.title;
      const result = await window.workingMemory.autocompleteTopic({
        body: topic.body || topic.title,
        currentTitle: topic.title,
        currentTopicType: topic.topicType,
        topicTypes: (topic.topicTypes ?? [topic.typeMeta ?? {
          slug: topic.topicType, label: topic.topicType, description: '',
        }]).map(({ slug, label, description }) => ({ slug: slug ?? '', label, description })),
        currentWorkstreamTitle: draft.title,
      });
      if (request !== generation) return;
      if (!result.workstreamTitle) throw new Error('Autocomplete did not suggest a workstream name.');
      if (!authored) draft.title = result.workstreamTitle;
    } catch (reason) {
      if (request === generation) suggestionError = reason instanceof Error ? reason.message : String(reason);
    } finally {
      if (request === generation) suggesting = false;
    }
  }

  async function move(): Promise<void> {
    if (moving || !draft.title.trim()) return;
    moving = true;
    generation += 1;
    suggesting = false;
    error = '';
    try {
      await beforeMove();
      await moveTopicToNewWorkstream(draft, window.workingMemory, onMove);
      onClose();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally { moving = false; }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="new-workstream-move-title" oncancel={(event) => { event.preventDefault(); if (!moving) onClose(); }}>
  <h2 id="new-workstream-move-title">Move to New Workstream</h2>
  <p>{topicTitle || source.slug}</p>
  <label>
    New workstream
    <input
      aria-label="New workstream"
      placeholder="New workstream"
      value={draft.title}
      maxlength="120"
      disabled={moving || Boolean(draft.targetWorkstream)}
      oninput={(event) => { authored = true; draft.title = event.currentTarget.value; }}
    />
  </label>
  <p>{draft.targetWorkstream
    ? 'The workstream has been created. Retry Move to finish moving the topic tree.'
    : 'Creates an In Progress workstream and moves this topic tree into it. Nothing changes until you click Move.'}</p>
  {#if suggesting}<p role="status">Suggesting a workstream name...</p>{/if}
  {#if suggestionError}<p class="error" role="alert">{suggestionError} You can enter a name manually.</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <footer>
    <button onclick={onClose} disabled={moving}>Cancel</button>
    {#if suggestionError && !draft.targetWorkstream}
      <button onclick={() => void suggestName()} disabled={moving || suggesting}>Retry suggestion</button>
    {/if}
    <button class="primary" onclick={() => void move()} disabled={moving || !draft.title.trim()}>
      {moving ? 'Moving...' : draft.targetWorkstream ? 'Retry Move' : 'Move'}
    </button>
  </footer>
</dialog>

<style>
  dialog { width: min(440px, 85vw); padding: 22px; border: 1px solid #bcb7bc; border-radius: 8px; color: #29252a; background: #faf9f7; }
  dialog::backdrop { background: #0006; }
  h2 { margin-top: 0; }
  p { font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
  label { display: grid; gap: 6px; font-size: 13px; }
  input { box-sizing: border-box; width: 100%; padding: 8px; font: inherit; }
  .error { color: #91251f; }
  footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
  button { padding: 7px 14px; }
  .primary { border: 1px solid transparent; border-radius: 4px; color: white; background: var(--desktop-accent-strong, #51465c); }
  .primary:disabled { opacity: 0.5; }
</style>
