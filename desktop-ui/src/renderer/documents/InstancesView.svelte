<script lang="ts">
  import { onMount } from 'svelte';
  import type { DataTierInstanceStatus, DataTierInstancesSnapshot, UpdateChannel } from '../../shared/contracts';

  interface Props {
    selectedMcpUrl: string | null;
    onMakeCurrent: (mcpUrl: string) => Promise<void>;
    onInstancesChanged: () => Promise<void>;
  }

  let { selectedMcpUrl, onMakeCurrent, onInstancesChanged }: Props = $props();

  const STATE_LABELS: Record<DataTierInstanceStatus['state'], string> = {
    running: 'Running',
    starting: 'Starting',
    unhealthy: 'Unhealthy',
    stopped: 'Stopped',
    missing: 'Container missing',
    unknown: 'Unknown',
  };

  let snapshot = $state<DataTierInstancesSnapshot | null>(null);
  let supported = $state(true);
  let loading = $state(true);
  let busy = $state<string | null>(null);
  let status = $state('');
  let newName = $state('');

  onMount(() => {
    void refresh();
  });

  // Docker reports health a few seconds after the server answers; re-poll until it settles.
  $effect(() => {
    if (busy || !snapshot?.instances.some((instance) => instance.state === 'starting')) return;
    const timer = setTimeout(() => void refresh(true), 3000);
    return () => clearTimeout(timer);
  });

  async function refresh(quiet = false): Promise<void> {
    if (!quiet) loading = true;
    try {
      const next = await window.workingMemory.listInstances();
      supported = next !== null;
      snapshot = next;
    } catch (error) {
      status = message(error);
    } finally {
      loading = false;
    }
  }

  function message(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
  }

  async function run(
    key: string,
    progress: string,
    operation: () => Promise<DataTierInstancesSnapshot | null>,
    done: string,
  ): Promise<boolean> {
    if (busy) return false;
    busy = key;
    status = progress;
    try {
      snapshot = await operation();
      status = done;
      await onInstancesChanged();
      return true;
    } catch (error) {
      status = message(error);
      await refresh();
      return false;
    } finally {
      busy = null;
    }
  }

  function addInstance(): void {
    const name = newName.trim();
    void run(
      'add',
      'Adding instance… Loading the bundled backend image can take a few minutes.',
      () => window.workingMemory.createInstance(name || undefined),
      'Instance added.',
    ).then((added) => {
      if (added) newName = '';
    });
  }

  function rename(instance: DataTierInstanceStatus, value: string): void {
    const name = value.trim();
    if (!name || name === instance.name) return;
    void run(`${instance.port}:rename`, 'Renaming…', () => window.workingMemory.renameInstance(instance.port, name), 'Renamed.');
  }

  async function backup(instance: DataTierInstanceStatus): Promise<void> {
    if (busy) return;
    busy = `${instance.port}:backup`;
    status = `Backing up ${instance.name}…`;
    try {
      const file = await window.workingMemory.backupInstance(instance.port);
      status = file ? `Backed up to ${file}` : '';
    } catch (error) {
      status = message(error);
    } finally {
      busy = null;
    }
  }

  async function makeCurrent(instance: { port: number; mcpUrl: string }): Promise<void> {
    if (busy) return;
    busy = `${instance.port}:current`;
    status = '';
    try {
      await onMakeCurrent(instance.mcpUrl);
    } finally {
      busy = null;
    }
  }

  function setChannel(channel: UpdateChannel): void {
    void run('channel', 'Checking the backend channel…', () => window.workingMemory.setBackendUpdateChannel(channel), '');
  }

  function active(instance: DataTierInstanceStatus): boolean {
    return instance.state === 'running' || instance.state === 'starting' || instance.state === 'unhealthy';
  }
</script>

<div class="instances">
  <p>
    Each instance is a separate Working Memory control plane running in Docker with its own data.
    {#if snapshot}This app bundles backend version {snapshot.appVersion}.{/if}
  </p>

  {#if !supported}
    <p class="instances-note">
      Instance management needs a build that bundles the Working Memory data tier. Run
      <code>npm run build</code> in <code>desktop-ui</code> or install a release build.
    </p>
  {:else}
    {#if snapshot?.dockerError}
      <p class="instances-note" role="alert">
        {snapshot.dockerError} Starting or adding an instance starts Docker Desktop when it is installed.
      </p>
    {/if}

    {#if snapshot}
      <label class="backend-channel">
        Backend update channel
        <select
          value={snapshot.backendChannel}
          disabled={busy !== null}
          onchange={(event) => setChannel(event.currentTarget.value as UpdateChannel)}
        >
          <option value="off">Off — use the version bundled with this app</option>
          <option value="canary">Canary — latest build from main</option>
          <option value="stable">Stable — tagged releases only</option>
        </select>
        <span class="instances-hint">
          {#if snapshot.backendTargetError}
            {snapshot.backendTargetError}
          {:else if snapshot.backendTarget}
            Instances update to {snapshot.backendTarget.version}. Upgrades keep each instance's data.
          {/if}
        </span>
      </label>
    {/if}

    <div class="instance-list" aria-busy={loading}>
      {#each snapshot?.instances ?? [] as instance (instance.port)}
        {@const current = instance.mcpUrl === selectedMcpUrl}
        <article class="instance" class:current>
          <div class="instance-identity">
            <input
              class="instance-name"
              aria-label={`Name for instance on port ${instance.port}`}
              value={instance.name}
              maxlength="80"
              disabled={busy !== null}
              onchange={(event) => rename(instance, event.currentTarget.value)}
              onkeydown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }}
            />
            <span class="instance-meta">127.0.0.1:{instance.port} · {instance.container}</span>
          </div>
          <span class="instance-state state-{instance.state}">{STATE_LABELS[instance.state]}</span>
          <span class="instance-version">
            {instance.version ?? '—'}
            {#if instance.updateAvailable}<em>Update available</em>{/if}
          </span>
          <div class="instance-actions">
            {#if current}
              <span class="instance-current"><span aria-hidden="true" class="codicon codicon-check"></span>Current</span>
            {:else}
              <button
                class="secondary"
                disabled={busy !== null || instance.state !== 'running'}
                onclick={() => void makeCurrent(instance)}
              >Make current</button>
            {/if}
            {#if active(instance)}
              <button
                disabled={busy !== null || current}
                title={current ? 'Switch to another instance before stopping this one.' : undefined}
                onclick={() => void run(`${instance.port}:stop`, `Stopping ${instance.name}…`, () => window.workingMemory.stopInstance(instance.port), 'Stopped.')}
              >{busy === `${instance.port}:stop` ? 'Stopping…' : 'Stop'}</button>
            {:else}
              <button
                disabled={busy !== null}
                onclick={() => void run(`${instance.port}:start`, `Starting ${instance.name}…`, () => window.workingMemory.startInstance(instance.port), 'Started.')}
              >{busy === `${instance.port}:start` ? 'Starting…' : 'Start'}</button>
            {/if}
            {#if instance.updateAvailable}
              <button
                class="secondary"
                disabled={busy !== null}
                onclick={() => void run(`${instance.port}:upgrade`, `Updating ${instance.name} to ${snapshot?.backendTarget?.version}… Downloading the image can take a few minutes; data is kept.`, () => window.workingMemory.upgradeInstance(instance.port), 'Updated.')}
              >{busy === `${instance.port}:upgrade` ? 'Updating…' : `Update to ${snapshot?.backendTarget?.version}`}</button>
            {/if}
            <button
              disabled={busy !== null || instance.state !== 'running'}
              title="Save a copy of this instance's SQLite database"
              onclick={() => void backup(instance)}
            >{busy === `${instance.port}:backup` ? 'Backing up…' : 'Back up…'}</button>
          </div>
        </article>
      {/each}
      {#each snapshot?.selfHosted ?? [] as instance (instance.port)}
        {@const current = instance.mcpUrl === selectedMcpUrl}
        <article class="instance self-hosted" class:current>
          <div class="instance-identity">
            <span class="instance-name">{instance.name}</span>
            <span class="instance-meta">127.0.0.1:{instance.port} · Not managed by this app</span>
          </div>
          <span class="instance-state state-self-hosted" title="You can connect to this server, but start, stop, upgrade, and backup are managed outside this app.">Self-hosted</span>
          <span class="instance-version"></span>
          <div class="instance-actions">
            {#if current}
              <span class="instance-current"><span aria-hidden="true" class="codicon codicon-check"></span>Current</span>
            {:else}
              <button class="secondary" disabled={busy !== null} onclick={() => void makeCurrent(instance)}>Make current</button>
            {/if}
          </div>
        </article>
      {/each}
      {#if !snapshot?.instances.length && !snapshot?.selfHosted.length}
        <p class="instances-empty">
          {loading ? 'Loading instances…' : 'No instances yet. Add one to start a Working Memory data tier in Docker.'}
        </p>
      {/if}
    </div>

    <div class="instance-add">
      <input placeholder="Name (optional)" aria-label="New instance name" maxlength="80" bind:value={newName} disabled={busy !== null} />
      <button class="add-model" disabled={busy !== null} onclick={addInstance}>
        <span aria-hidden="true" class="codicon codicon-add"></span>
        {busy === 'add' ? 'Adding…' : 'Add instance'}
      </button>
    </div>
    <p class="instances-hint">
      New instances use port 7717 when it is free, otherwise the next free port from 7719 to 7799.
    </p>
  {/if}

  {#if status}<p class="instances-status" role="status">{status}</p>{/if}
</div>
