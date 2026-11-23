<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, titleId, label, class: className = '', actions, children, onClose, closeLabel = 'Close', busy = false }: {
    title: string;
    titleId?: string;
    label?: string;
    class?: string;
    actions?: Snippet;
    children: Snippet;
    onClose?: () => void;
    closeLabel?: string;
    busy?: boolean;
  } = $props();
</script>

<section class={`popup-frame ${className}`} aria-label={label}>
  <header class="popup-heading">
    <h2 id={titleId}>{title}</h2>
    <div class="popup-actions">
      {@render actions?.()}
      {#if onClose}
        <button class="popup-action-button" aria-label={closeLabel} title={closeLabel} disabled={busy}
          onclick={() => { if (!busy) onClose?.(); }}>
          <span class="codicon codicon-close" aria-hidden="true"></span>
        </button>
      {/if}
    </div>
  </header>
  <div class="popup-content">{@render children()}</div>
</section>

<style>
  .popup-frame { padding: 10px 12px; min-width: 0; background: var(--vscode-editor-background); }
  .popup-heading { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  h2 { margin: 0; font-size: 0.95em; }
  .popup-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
  .popup-content { overflow: auto; min-width: 0; }
</style>
