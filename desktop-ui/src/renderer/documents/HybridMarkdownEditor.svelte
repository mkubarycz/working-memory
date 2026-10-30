<script lang="ts">
  import { onMount } from 'svelte';
  import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
  import { markdown } from '@codemirror/lang-markdown';
  import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
  import { tags } from '@lezer/highlight';
  import { Autolink } from '@lezer/markdown';
  import { Compartment, EditorState, Transaction } from '@codemirror/state';
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
  import { resolveMarkdownImageSource } from './markdown';
  import { markdownFromClipboard } from './markdownPaste';
  import {
    activateLivePreview,
    liveMarkdownPreview,
    liveMarkdownTheme,
    livePreviewActivated,
    markdownLinkClicks,
    resetLivePreview,
  } from './liveMarkdownPreview';

  interface Props {
    value: string;
    label?: string;
    disabled?: boolean;
    attachmentBaseUrl?: string;
    onInput: (value: string) => void;
    onAttachImages?: (files: File[]) => Promise<AttachmentRef[]>;
    onOpenLink?: (href: string) => void;
  }

  let {
    value,
    label = 'Topic body (Markdown live preview)',
    disabled = false,
    attachmentBaseUrl = '',
    onInput,
    onAttachImages,
    onOpenLink,
  }: Props = $props();

  let host = $state<HTMLDivElement | null>(null);
  let view = $state<EditorView | null>(null);
  const editable = new Compartment();
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
    const attach = onAttachImages;
    if (!view || disabled || !attach || files.length === 0 || attachingImages) return;
    const sourceView = view;
    const applyInput = onInput;
    const selection = sourceView.state.selection.main;
    attachingImages = true;
    attachmentError = '';
    try {
      const markdownSource = attachmentMarkdown(await attach(files));
      if (disabled) throw new Error('The editor is read-only. The image could not be inserted.');
      const before = sourceView.state.doc.sliceString(0, selection.from);
      const after = sourceView.state.doc.sliceString(selection.to);
      const prefix = before && !before.endsWith('\n') ? '\n\n' : '';
      const suffix = after && !after.startsWith('\n') ? '\n\n' : '';
      const inserted = `${prefix}${markdownSource}${suffix}`;
      if (view !== sourceView) {
        applyInput(`${before}${inserted}${after}`);
        return;
      }
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
          markdown({ extensions: [Autolink] }),
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
          editable.of([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]),
          EditorView.contentAttributes.of({
            'aria-label': label,
            spellcheck: 'true',
          }),
          placeholder('Write a note…'),
          livePreviewActivated,
          liveMarkdownPreview,
          liveMarkdownTheme,
          attachmentImagePreview(attachmentBaseUrl),
          onOpenLink
            ? markdownLinkClicks((href) => onOpenLink(resolveMarkdownImageSource(href, attachmentBaseUrl)))
            : [],
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
            paste: (event, currentView) => {
              if (disabled) return false;
              const files = imageFilesFromTransfer(event.clipboardData);
              if (onAttachImages && files.length > 0) {
                event.preventDefault();
                void attachImages(files);
                return true;
              }
              try {
                const source = markdownFromClipboard(event.clipboardData);
                if (source === null) return false;
                event.preventDefault();
                attachmentError = '';
                if (source) {
                  currentView.dispatch(currentView.state.replaceSelection(source), {
                    effects: activateLivePreview.of(),
                    userEvent: 'input.paste',
                    scrollIntoView: true,
                  });
                }
                return true;
              } catch (error) {
                event.preventDefault();
                attachmentError = error instanceof Error ? error.message : String(error);
                return true;
              }
            },
            dragover: (event) => {
              if (disabled || !onAttachImages) return false;
              const hasImage = [...(event.dataTransfer?.items ?? [])]
                .some((item) => item.kind === 'file' && item.type.startsWith('image/'));
              if (!hasImage) return false;
              event.preventDefault();
              if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
              return true;
            },
            drop: (event) => {
              if (disabled || !onAttachImages) return false;
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
  $effect(() => {
    view?.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) });
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
