<script lang="ts">
  import { onMount } from 'svelte';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { tags } from '@lezer/highlight';
  import { EditorState, Transaction } from '@codemirror/state';
  import {
    drawSelection,
    dropCursor,
    EditorView,
    keymap,
    placeholder,
  } from '@codemirror/view';
  import type { AttachmentRef } from './types';
  import { imageFilesFromTransfer } from './imageFiles';
  import { attachmentImagePreview } from './attachmentImages';
  import {
    activateLivePreview,
    liveMarkdownPreview,
    liveMarkdownTheme,
    livePreviewActivated,
    resetLivePreview,
  } from './liveMarkdownPreview';

  interface Props {
    value: string;
    attachmentBaseUrl?: string;
    onInput: (value: string) => void;
    onAttachImages?: (files: File[]) => Promise<AttachmentRef[]>;
  }

  let {
    value,
    attachmentBaseUrl = '',
    onInput,
    onAttachImages = async () => [],
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let view: EditorView | null = null;
  let attachingImages = $state(false);
  let attachmentError = $state('');
  let syncingExternalValue = false;

  function activateAfterEvent(currentView: EditorView): void {
    queueMicrotask(() => {
      if (view !== currentView || currentView.state.field(livePreviewActivated)) return;
      currentView.dispatch({ effects: activateLivePreview.of() });
    });
  }

  function attachmentMarkdown(attachments: AttachmentRef[]): string {
    return attachments
      .map((attachment) => `![${attachment.filename.replace(/[\[\]]/g, '')}](wm-attachment:${attachment.id})`)
      .join('\n\n');
  }

  async function attachImages(files: File[]): Promise<void> {
    if (!view || files.length === 0 || attachingImages) return;
    const selection = view.state.selection.main;
    attachingImages = true;
    attachmentError = '';
    try {
      const markdownSource = attachmentMarkdown(await onAttachImages(files));
      const before = view.state.doc.sliceString(0, selection.from);
      const after = view.state.doc.sliceString(selection.to);
      const prefix = before && !before.endsWith('\n') ? '\n\n' : '';
      const suffix = after && !after.startsWith('\n') ? '\n\n' : '';
      const inserted = `${prefix}${markdownSource}${suffix}`;
      view.dispatch({
        changes: { from: selection.from, to: selection.to, insert: inserted },
        selection: { anchor: selection.from + inserted.length },
        effects: activateLivePreview.of(),
        scrollIntoView: true,
      });
      view.focus();
    } catch (error) {
      attachmentError = error instanceof Error ? error.message : String(error);
    } finally {
      attachingImages = false;
    }
  }

  onMount(() => {
    if (!host) return;
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown(),
          syntaxHighlighting(HighlightStyle.define([
            { tag: tags.strong, class: 'cm-live-strong' },
            { tag: tags.emphasis, class: 'cm-live-emphasis' },
            { tag: tags.link, class: 'cm-live-link' },
            { tag: tags.monospace, class: 'cm-live-monospace' },
          ])),
          history(),
          drawSelection(),
          dropCursor(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': 'Topic body (Markdown live preview)',
            spellcheck: 'true',
          }),
          placeholder('Write a note…'),
          livePreviewActivated,
          liveMarkdownPreview,
          liveMarkdownTheme,
          attachmentImagePreview(attachmentBaseUrl),
          EditorView.theme({
            '&': {
              minHeight: '240px',
              backgroundColor: 'transparent',
              color: 'var(--vscode-editor-foreground)',
            },
            '.cm-scroller': {
              fontFamily: 'var(--vscode-font-family)',
              lineHeight: '1.6',
              overflow: 'visible',
            },
            '.cm-content': {
              minHeight: '240px',
              padding: '14px 16px 24px',
              caretColor: 'var(--vscode-editorCursor-foreground)',
            },
            '&.cm-focused': { outline: 'none' },
            '.cm-gutters': { display: 'none' },
            '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
              backgroundColor: 'var(--vscode-editor-selectionBackground)',
            },
          }),
          EditorView.domEventHandlers({
            mouseup: (_event, currentView) => {
              activateAfterEvent(currentView);
              return false;
            },
            keydown: (_event, currentView) => {
              activateAfterEvent(currentView);
              return false;
            },
            paste: (event) => {
              const files = imageFilesFromTransfer(event.clipboardData);
              if (files.length === 0) return false;
              event.preventDefault();
              void attachImages(files);
              return true;
            },
            dragover: (event) => {
              const hasImage = [...(event.dataTransfer?.items ?? [])]
                .some((item) => item.kind === 'file' && item.type.startsWith('image/'));
              if (!hasImage) return false;
              event.preventDefault();
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
              return true;
            },
            drop: (event) => {
              const files = imageFilesFromTransfer(event.dataTransfer);
              if (files.length === 0) return false;
              event.preventDefault();
              void attachImages(files);
              return true;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || syncingExternalValue) return;
            onInput(update.state.doc.toString());
          }),
        ],
      }),
    });
    return () => {
      view?.destroy();
      view = null;
    };
  });

  $effect(() => {
    if (!view || value === view.state.doc.toString()) return;
    syncingExternalValue = true;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      selection: { anchor: 0 },
      effects: resetLivePreview.of(),
      annotations: Transaction.addToHistory.of(false),
    });
    syncingExternalValue = false;
  });
</script>

<div class="hybrid-editor" bind:this={host}></div>
{#if attachingImages}<p class="attachment-status">Attaching image…</p>{/if}
{#if attachmentError}<p class="attachment-error" role="alert">{attachmentError}</p>{/if}

<style>
  .hybrid-editor {
    min-height: 240px;
    --md-heading: var(--vscode-editor-foreground);
    --md-bold: var(--vscode-editor-foreground);
    --md-italic: var(--vscode-editor-foreground);
    --md-link: var(--vscode-textLink-foreground);
    --md-code-bg: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.1));
  }

  .hybrid-editor :global(.hybrid-markdown-image) {
    box-sizing: border-box;
    margin: 0;
    padding: 12px 0;
  }

  .hybrid-editor :global(.hybrid-markdown-image img) {
    display: block;
    max-width: 100%;
    max-height: 560px;
    border-radius: 4px;
  }

  .hybrid-editor :global(.hybrid-markdown-image figcaption) {
    margin-top: 4px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.82em;
  }

  .attachment-status,
  .attachment-error {
    margin: 8px 12px;
    font-size: 0.85em;
  }

  .attachment-status {
    color: var(--vscode-descriptionForeground);
  }

  .attachment-error {
    color: var(--vscode-errorForeground);
  }
</style>
