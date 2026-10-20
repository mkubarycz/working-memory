<script lang="ts">
  import type { AlertVM } from './types';
  import AlertCallouts from './AlertCallouts.svelte';

  interface Props {
    /** Closed (dismissed) alerts in scope, most recently closed first. */
    alerts: AlertVM[];
    onSetAlertStatus: (id: string, status: AlertVM['status']) => void;
  }

  let { alerts, onSetAlertStatus }: Props = $props();

  let open = $state(true);
</script>

{#if alerts.length > 0}
  <section class="alert-history" aria-label="Alert history">
    <h2>
      <button
        class="twistie"
        aria-expanded={open}
        aria-label="{open ? 'Collapse' : 'Expand'} alert history"
        onclick={() => (open = !open)}
      >
        <span aria-hidden="true" class="codicon codicon-chevron-{open ? 'down' : 'right'}"></span>
      </button>
      <span class="codicon codicon-history"></span>
      <span>Alert history</span>
      <span class="history-count" title="{alerts.length} closed alert{alerts.length === 1 ? '' : 's'}">{alerts.length}</span>
    </h2>
    {#if open}
      <AlertCallouts {alerts} {onSetAlertStatus} />
    {/if}
  </section>
{/if}

<style>
  .alert-history {
    margin-top: 18px;
  }

  .alert-history h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1.05em;
    margin: 0 0 8px;
  }

  .twistie {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    padding: 0;
    border: none;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .history-count {
    font-size: 0.75em;
    font-weight: normal;
    color: var(--vscode-descriptionForeground);
  }
</style>
