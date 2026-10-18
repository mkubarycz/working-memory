<script lang="ts">
  import { onMount } from 'svelte';
  import type { DesktopUpdateState, UpdateChannel } from '../../shared/contracts';

  const CHANNELS: Array<{ id: UpdateChannel; label: string; detail: string }> = [
    { id: 'off', label: 'Off', detail: 'Never check for updates. Use for local development builds.' },
    { id: 'canary', label: 'Canary', detail: 'The latest build from main. Newest changes, least tested.' },
    { id: 'stable', label: 'Stable', detail: 'Tagged releases only.' },
  ];

  let update = $state<DesktopUpdateState | null>(null);
  let error = $state('');

  onMount(() => {
    const unsubscribe = window.workingMemory.onDesktopUpdate((state) => (update = state));
    void act(() => window.workingMemory.getDesktopUpdate());
    return unsubscribe;
  });

  async function act(operation: () => Promise<DesktopUpdateState>): Promise<void> {
    error = '';
    try {
      update = await operation();
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      error = text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
    }
  }

  function setChannel(channel: UpdateChannel): void {
    void act(() => window.workingMemory.setDesktopUpdateChannel(channel));
  }

  const busy = $derived(
    update?.phase === 'checking' || update?.phase === 'downloading' || update?.phase === 'installing',
  );
</script>

<div class="updates">
  <p>
    The desktop app and each data tier instance update separately. Choose the data tier channel on the
    Instances tab.
  </p>
  <fieldset class="update-channels">
    <legend>Desktop update channel</legend>
    {#each CHANNELS as channel (channel.id)}
      <label>
        <input
          type="radio"
          name="desktop-update-channel"
          value={channel.id}
          checked={update?.channel === channel.id}
          disabled={!update || busy}
          onchange={() => setChannel(channel.id)}
        />
        <span><strong>{channel.label}</strong> {channel.detail}</span>
      </label>
    {/each}
  </fieldset>

  {#if update}
    <p class="update-version">Installed version <strong>{update.currentVersion}</strong></p>
    {#if !update.supported}
      <p class="instances-note">{update.unsupportedReason}</p>
    {:else if update.channel !== 'off'}
      <div class="update-status" role="status">
        {#if update.phase === 'checking'}
          Checking for updates…
        {:else if update.phase === 'up-to-date'}
          You are on the latest {update.channel} version.
        {:else if update.phase === 'available' && update.available}
          Version {update.available.version} is available.
        {:else if update.phase === 'downloading'}
          Downloading {update.available?.version}… {Math.round((update.progress ?? 0) * 100)}%
          <progress max="1" value={update.progress ?? 0}></progress>
        {:else if update.phase === 'ready'}
          Version {update.available?.version} is ready. Restart to finish installing.
        {:else if update.phase === 'installing'}
          Installing… Working Memory will restart.
        {:else if update.phase === 'error'}
          {update.error}
        {/if}
        {#if update.checkedAt && update.phase !== 'checking'}
          <span class="update-checked">Last checked {new Date(update.checkedAt).toLocaleString()}</span>
        {/if}
      </div>
      <div class="settings-actions">
        <button disabled={busy} onclick={() => void act(() => window.workingMemory.checkDesktopUpdate())}>
          Check now
        </button>
        {#if update.phase === 'available'}
          <button class="primary" onclick={() => void act(() => window.workingMemory.downloadDesktopUpdate())}>
            Download {update.available?.version}
          </button>
        {:else if update.phase === 'ready'}
          <button
            class="primary"
            onclick={() => void act(async () => {
              await window.workingMemory.installDesktopUpdate();
              return window.workingMemory.getDesktopUpdate();
            })}
          >
            Restart and install
          </button>
        {/if}
        {#if update.available}
          <a href={update.available.releaseUrl} target="_blank" rel="noreferrer">Release notes</a>
        {/if}
      </div>
    {/if}
  {/if}
  {#if error}<p class="instances-status" role="alert">{error}</p>{/if}
</div>
