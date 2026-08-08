<script lang="ts">
  import type { AlertVM } from './types';
  import { renderMarkdown } from './markdown';

  interface Props {
    alerts: AlertVM[];
    onSetAlertStatus: (id: string, status: AlertVM['status']) => void;
  }

  let { alerts, onSetAlertStatus }: Props = $props();

  interface ActionButton {
    label: string;
    icon: string;
    status: AlertVM['status'];
  }

  // Lifecycle button set ported from the retired journal alert renderer
  // (git 2313666): active → Acknowledge/Close, informational → Escalate/Close,
  // closed → Reopen (Alert)/Reopen (Information). Each maps to a target status.
  function actionsFor(status: AlertVM['status']): ActionButton[] {
    if (status === 'closed') {
      return [
        { label: 'Reopen (Alert)', icon: 'bell', status: 'alert' },
        { label: 'Reopen (Information)', icon: 'info', status: 'informational' },
      ];
    }
    if (status === 'informational') {
      return [
        { label: 'Escalate', icon: 'bell', status: 'alert' },
        { label: 'Close', icon: 'pass', status: 'closed' },
      ];
    }
    return [
      { label: 'Acknowledge', icon: 'info', status: 'informational' },
      { label: 'Close', icon: 'pass', status: 'closed' },
    ];
  }
</script>

{#if alerts.length > 0}
  <section class="alerts" aria-label="Alerts">
    {#each alerts as a (a.id)}
      <div
        class="callout {a.status}"
        class:dimmed={a.dimmed}
        role="note"
      >
        <div class="callout-head">
          <span class="callout-title">{a.title}</span>
        </div>
        {#if a.description.trim()}
          <!-- Safe to inject: renderMarkdown uses markdown-it `html: false`, so
               authored raw HTML is escaped rather than emitted as live markup. -->
          <div class="callout-body markdown-body">{@html renderMarkdown(a.description)}</div>
        {/if}
        {#if a.recommendedAction.trim()}
          <div class="callout-next">
            <span class="next-label">Recommended action</span>
            <!-- Safe: see note above (html: false). -->
            <div class="markdown-body">{@html renderMarkdown(a.recommendedAction)}</div>
          </div>
        {/if}
        <div class="callout-actions">
          {#each actionsFor(a.status) as action (action.label)}
            <button
              type="button"
              class="alert-action"
              onclick={() => onSetAlertStatus(a.id, action.status)}
            >
              <span class="codicon codicon-{action.icon}"></span>
              {action.label}
            </button>
          {/each}
        </div>
      </div>
    {/each}
  </section>
{/if}

<style>
  .alerts {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .callout {
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border-left-width: 4px;
    border-radius: 5px;
    padding: 10px 14px;
    background: var(--vscode-editor-background);
  }

  /* Active alert: red left-edge accent over a subdued, mostly-dark background. */
  .callout.alert {
    border-left-color: var(--vscode-editorError-foreground, #f14c4c);
    background: color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 6%, var(--vscode-editor-background));
  }

  /* Informational: blue left-edge accent over a near-black background so it
     recedes rather than glowing blue. */
  .callout.informational {
    border-left-color: var(--vscode-editorInfo-foreground, #3794ff);
    background: color-mix(in srgb, #000 28%, var(--vscode-editor-background));
  }

  /* Recently-closed: muted, kept only so Reopen stays reachable. */
  .callout.closed {
    border-left-color: var(--vscode-charts-green, #89d185);
  }

  .callout.dimmed {
    opacity: 0.6;
  }

  .callout-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .callout-title {
    font-weight: 600;
  }

  .callout-body {
    margin-top: 4px;
  }

  .callout-next {
    margin-top: 6px;
  }

  .next-label {
    display: block;
    font-size: 0.72em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 2px;
  }

  .callout-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }

  .alert-action {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 3px;
    background: var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.2));
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    cursor: pointer;
    font-size: 0.85em;
  }

  .alert-action:hover {
    background: var(
      --vscode-button-secondaryHoverBackground,
      var(--vscode-button-secondaryBackground)
    );
  }

  /* Rendered markdown blocks inside a callout stay compact. */
  .markdown-body {
    line-height: 1.5;
    word-break: break-word;
  }

  .markdown-body :global(p) {
    margin: 0.25em 0;
  }

  .markdown-body :global(:first-child) {
    margin-top: 0;
  }

  .markdown-body :global(:last-child) {
    margin-bottom: 0;
  }

  .markdown-body :global(code) {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.9em;
    padding: 0.1em 0.3em;
    border-radius: 3px;
    background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.1));
  }

  .markdown-body :global(a) {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
  }

  .markdown-body :global(a:hover) {
    text-decoration: underline;
  }
</style>
