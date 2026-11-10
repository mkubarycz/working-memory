<script lang="ts" module>
  import type { DataTierInstanceStatus, DataTierInstancesSnapshot, UpdateChannel } from '../../shared/contracts';

  const REFRESH_INTERVAL_MS = 15_000;
  let cached: {
    snapshot: DataTierInstancesSnapshot | null;
    provider: 'docker' | 'podman';
    refreshedAt: number;
  } | undefined;
  let revision = 0;
</script>

<script lang="ts">
  import { onMount } from 'svelte';

  interface Props {
    section?: 'backend' | 'provider' | 'all';
    selectedMcpUrl: string | null;
    onMakeCurrent: (mcpUrl: string) => Promise<void>;
    onInstancesChanged: () => Promise<void>;
  }

  let { section = 'all', selectedMcpUrl, onMakeCurrent, onInstancesChanged }: Props = $props();

  const STATE_LABELS: Record<DataTierInstanceStatus['state'], string> = {
    running: 'Running',
    starting: 'Starting',
    unhealthy: 'Unhealthy',
    stopped: 'Stopped',
    missing: 'Container missing',
    unknown: 'Unknown',
  };

  let snapshot = $state<DataTierInstancesSnapshot | null>(cached?.snapshot ?? null);
  let supported = $state(cached?.snapshot !== null);
  let loading = $state(cached === undefined);
  let busy = $state<string | null>(null);
  let status = $state('');
  let newName = $state('');
  let provider = $state<'docker' | 'podman'>(cached?.provider ?? 'docker');
  let refreshError = $state('');
  let refreshing = false;

  onMount(() => {
    const poll = (force = false) => {
      if (!document.hidden && !busy && (force || Date.now() - (cached?.refreshedAt ?? 0) >= REFRESH_INTERVAL_MS)) void refresh(true);
    };
    poll();
    const timer = setInterval(() => poll(true), REFRESH_INTERVAL_MS);
    const onVisibilityChange = () => poll();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      revision += 1;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  });

  // Docker reports health a few seconds after the server answers; re-poll until it settles.
  $effect(() => {
    if (section === 'provider' || busy || !snapshot?.instances.some((instance) => instance.state === 'starting')) return;
    const timer = setTimeout(() => { if (!document.hidden) void refresh(true); }, 3000);
    return () => clearTimeout(timer);
  });

  async function refresh(quiet = false): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    const current = revision;
    if (!quiet) loading = true;
    try {
      const nextProvider = await window.workingMemory.getContainerProvider();
      const next = await window.workingMemory.listInstances();
      if (current !== revision) return;
      provider = nextProvider;
      applySnapshot(next);
      refreshError = '';
    } catch (error) {
      if (current === revision) refreshError = message(error);
    } finally {
      loading = false;
      refreshing = false;
    }
  }

  function applySnapshot(next: DataTierInstancesSnapshot | null): void {
    snapshot = next;
    supported = next !== null;
    cached = { snapshot: next, provider, refreshedAt: Date.now() };
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
    revision += 1;
    busy = key;
    status = progress;
    try {
      applySnapshot(await operation());
      refreshError = '';
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

  async function setProvider(value: string): Promise<void> {
    if (value !== 'docker' && value !== 'podman') return;
    await run('provider', 'Changing container provider...', async () => {
      await window.workingMemory.setContainerProvider(value);
      provider = value;
      return window.workingMemory.listInstances();
    }, 'Container provider selected. Existing data stays with its original provider.');
  }

  function active(instance: DataTierInstanceStatus): boolean {
    return instance.state === 'running' || instance.state === 'starting' || instance.state === 'unhealthy';
  }
</script>

<div class="instances">
  {#if section !== 'provider'}
  <p>
    Each instance is a separate Working Memory control plane with its own data.
    {#if snapshot}This app bundles backend version {snapshot.appVersion}.{/if}
  </p>
  {/if}
  {#if section !== 'backend'}
  <label class="container-provider">
    Container provider
    <select value={provider} disabled={busy !== null || loading}
      onchange={(event) => void setProvider(event.currentTarget.value)}>
      <option value="docker">Docker</option>
      <option value="podman">Podman</option>
    </select>
    <span class="instances-hint">The selected provider must be running with Compose installed.
      Working Memory does not start providers or migrate data between them.</span>
  </label>
  {/if}

  {#if section === 'provider'}
    {#if snapshot?.dockerError}
      <p class="instances-note" role="alert">
        {snapshot.dockerError}
        <button disabled={busy !== null || loading} onclick={() => void refresh()}>Retry</button>
      </p>
    {/if}
  {:else if !supported}
    <p class="instances-note">
      Instance management needs a build that bundles the Working Memory data tier. Run
      <code>npm run build</code> in <code>desktop-ui</code> or install a release build.
    </p>
  {:else}
    {#if snapshot?.dockerError}
      <p class="instances-note" role="alert">
        {snapshot.dockerError}
        <button disabled={busy !== null || loading} onclick={() => void refresh()}>Retry</button>
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
          <option value="canary">Canary — newest rolling or Stable build</option>
          <option value="stable">Stable — latest non-prerelease tag</option>
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
            <span title="Version from this instance's container image.">Current version <strong>{instance.version ?? 'Unknown'}</strong></span>
            {#if instance.version === null}
              <span>Update availability cannot be determined.</span>
            {/if}
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

  {#if refreshError}<p class="instances-note" role="alert">{refreshError}
    <button disabled={busy !== null || loading} onclick={() => void refresh()}>Retry</button>
  </p>{/if}
  {#if status}<p class="instances-status" role="status">{status}</p>{/if}
</div>
