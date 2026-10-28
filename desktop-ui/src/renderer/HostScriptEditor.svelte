<script lang="ts">
  import { onMount } from 'svelte';
  import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
  import { javascript } from '@codemirror/lang-javascript';
  import { json } from '@codemirror/lang-json';
  import { bracketMatching, defaultHighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
  import { Compartment, EditorState, Transaction } from '@codemirror/state';
  import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';

  let { value, label, language = 'javascript', disabled = false, minHeight = 200, onInput, onBlur }: {
    value: string; label: string; language?: 'javascript' | 'json'; disabled?: boolean; minHeight?: number;
    onInput: (value: string) => void; onBlur?: () => void;
  } = $props();
  let host: HTMLDivElement;
  let view = $state<EditorView | null>(null);
  let syncing = false;
  const editable = new Compartment();

  onMount(() => {
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          language === 'json' ? json() : javascript(), lineNumbers(), history(), drawSelection(),
          bracketMatching(), indentOnInput(), indentUnit.of('  '), syntaxHighlighting(defaultHighlightStyle),
          keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
          editable.of([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]),
          EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true', spellcheck: 'false' }),
          EditorView.theme({
            '&': { backgroundColor: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)' },
            '&.cm-focused': { outline: '2px solid var(--vscode-focusBorder)', outlineOffset: '-1px' },
            '.cm-scroller': { fontFamily: 'Menlo, Monaco, monospace', fontSize: '12px', lineHeight: '1.6', maxHeight: '440px', overflow: 'auto' },
            '.cm-content': { minHeight: `${minHeight}px`, padding: '10px 0', caretColor: 'var(--vscode-input-foreground)' },
            '.cm-line': { padding: '0 12px' },
            '.cm-gutters': { backgroundColor: 'var(--vscode-editor-background)', color: 'var(--vscode-descriptionForeground)',
              borderRight: '1px solid var(--vscode-input-border)' },
            '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--desktop-accent-soft)' },
          }),
          EditorView.domEventHandlers({ blur: () => { onBlur?.(); } }),
          EditorView.updateListener.of(update => { if (update.docChanged && !syncing) onInput(update.state.doc.toString()); }),
        ],
      }),
    });
    return () => { view?.destroy(); view = null; };
  });
  $effect(() => {
    if (!view || value === view.state.doc.toString()) return;
    syncing = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, annotations: Transaction.addToHistory.of(false) });
    syncing = false;
  });
  $effect(() => { view?.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) }); });
</script>

<div class="code-editor" data-editor={label} bind:this={host}></div>

<style>
  .code-editor { min-width: 0; overflow: hidden; border: 1px solid var(--vscode-input-border); border-radius: 4px; }
</style>
