<script lang="ts">
  import { onMount, tick } from 'svelte';
  import type { AgentMessageVM, SnoozeAgentMessage } from './types';
  import { customReminderDeadline, presetReminderDeadline, type ReminderSnoozePreset } from '../agentMessages';

  let { message, onSnooze, onClose }: {
    message: AgentMessageVM;
    onSnooze: SnoozeAgentMessage;
    onClose: () => void;
  } = $props();
  let dialog: HTMLDialogElement;
  let customInput: HTMLInputElement | undefined = $state();
  let custom = $state(false);
  let value = $state('');
  let busy = $state(false);
  let error = $state('');
  let now = $state(Date.now());
  const presets: { value: ReminderSnoozePreset; label: string }[] = [
    { value: '10-minutes', label: '10 minutes' },
    { value: '1-hour', label: '1 hour' },
    { value: 'tomorrow', label: 'Tomorrow' },
    { value: 'next-week', label: 'Next week' },
  ];
  const preview = $derived.by(() => {
    if (!value.trim()) return { deadline: null, error: '' };
    try { return { deadline: customReminderDeadline(value), error: '' }; }
    catch (reason) { return { deadline: null, error: reason instanceof Error ? reason.message : String(reason) }; }
  });
  onMount(() => {
    dialog.showModal();
    const timer = window.setInterval(() => { now = Date.now(); }, 1000);
    return () => window.clearInterval(timer);
  });

  function formatDeadline(seconds: number): string {
    return new Date(seconds * 1000).toLocaleString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
  }

  function close(): void {
    if (busy) return;
    dialog.close();
    onClose();
  }

  async function enableCustom(): Promise<void> {
    custom = true;
    error = '';
    await tick();
    customInput?.focus();
  }

  async function snooze(deadline: number): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      if (deadline * 1000 <= Date.now()) throw new Error('That time has passed. Enter a new future time.');
      await onSnooze(message.id, deadline);
      dialog.close();
      onClose();
    } catch (reason) {
      error = reason instanceof Error ? reason.message : String(reason);
    } finally { busy = false; }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="snooze-reminder-title" closedby={busy ? 'none' : 'closerequest'}
  oncancel={(event) => { event.preventDefault(); close(); }}>
  <h2 id="snooze-reminder-title">Snooze reminder</h2>
  <p class="message-title">{message.title}</p>
  <div class="presets">
    {#each presets as preset}
      <button disabled={busy} onclick={() => void snooze(presetReminderDeadline(preset.value))}
        aria-label={preset.label}>
        <span>{preset.label}</span>
        <span class="preset-time">{formatDeadline(presetReminderDeadline(preset.value, now))}</span>
      </button>
    {/each}
  </div>
  {#if custom}
    <form onsubmit={(event) => { event.preventDefault(); if (preview.deadline !== null) void snooze(preview.deadline); }}>
      <label for="custom-snooze-time">Custom time</label>
      <input id="custom-snooze-time" bind:this={customInput} bind:value maxlength="500" disabled={busy}
        placeholder="e.g. in 45 minutes, Friday at 2pm" aria-describedby="custom-snooze-preview"
        aria-invalid={Boolean(preview.error)} oninput={() => { error = ''; }} />
      <p id="custom-snooze-preview" class:error={Boolean(preview.error)} role="status">
        {#if preview.deadline !== null}
          <time datetime={new Date(preview.deadline * 1000).toISOString()}>{formatDeadline(preview.deadline)}</time>
        {:else}
          {preview.error || 'Type a date or time. Parsed locally, without AI.'}
        {/if}
      </p>
      <button class="primary" type="submit" disabled={busy || preview.deadline === null}>
        {busy ? 'Snoozing...' : 'Snooze'}
      </button>
    </form>
  {:else}
    <button class="custom" disabled={busy} onclick={() => void enableCustom()}>Custom</button>
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <footer><button disabled={busy} onclick={close}>Cancel</button></footer>
</dialog>

<style>
  dialog { box-sizing: border-box; width: min(440px, 90vw); max-height: 85vh; overflow-y: auto; padding: 22px; border: 1px solid #bcb7bc; border-radius: 8px; color: #29252a; background: #faf9f7; }
  dialog::backdrop { background: #0006; }
  h2 { margin: 0 0 8px; font-size: 18px; }
  p { font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
  .message-title { margin: 0 0 16px; color: #70656d; }
  .presets { display: grid; gap: 6px; }
  button { padding: 8px 12px; border: 1px solid #bcb7bc; border-radius: 4px; color: inherit; background: transparent; }
  button:hover:not(:disabled) { border-color: var(--desktop-accent-strong, #bd1f66); }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--desktop-accent-strong, #bd1f66); outline-offset: 2px; }
  button:disabled { opacity: .5; cursor: default; }
  .presets button { display: grid; gap: 4px; text-align: left; }
  .preset-time { font-size: 11px; color: #70656d; }
  .custom { width: 100%; margin-top: 6px; text-align: left; }
  form { display: grid; gap: 8px; margin-top: 14px; }
  label { font-size: 13px; font-weight: 600; }
  input { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px; border: 1px solid #bcb7bc; border-radius: 4px; color: inherit; background: white; }
  form p { margin: 0; }
  .primary { justify-self: end; border-color: var(--desktop-accent-strong, #bd1f66); color: var(--desktop-accent-strong, #bd1f66); font-weight: 700; }
  .error { color: #91251f; }
  footer { display: flex; justify-content: flex-end; margin-top: 18px; }
</style>
