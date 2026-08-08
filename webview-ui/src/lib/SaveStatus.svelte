<script lang="ts">
  import type { SaveState } from './types';

  interface Props {
    state: SaveState;
  }

  let { state }: Props = $props();

  // idle renders nothing; the rest map to a colored dot + label.
  const LABELS: Record<Exclude<SaveState, 'idle'>, string> = {
    pending: 'Pending',
    saving: 'Saving…',
    saved: 'Saved',
    error: 'Error',
  };

  const label = $derived(state === 'idle' ? '' : LABELS[state]);
</script>

{#if state !== 'idle'}
  <span class="save-status {state}" role="status" aria-live="polite">
    <span class="dot" aria-hidden="true"></span>
    <span class="text">{label}</span>
  </span>
{/if}

<style>
  .save-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--vscode-descriptionForeground);
  }

  .save-status.pending .dot,
  .save-status.saving .dot {
    background: var(--vscode-charts-yellow, #e2c08d);
  }

  .save-status.saved .dot {
    background: var(--vscode-charts-green, #89d185);
  }

  .save-status.error .dot {
    background: var(--vscode-charts-red, #f14c4c);
  }

  .save-status.error .text {
    color: var(--vscode-inputValidation-errorForeground, var(--vscode-errorForeground));
  }
</style>
