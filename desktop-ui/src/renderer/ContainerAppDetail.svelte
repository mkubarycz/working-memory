<script lang="ts">
  import type { ContainerAppStatus } from '../shared/contracts';
  import type { ContainerAppItem } from './containerApps';

  interface Props {
    app: ContainerAppItem;
    status?: ContainerAppStatus;
    busy: boolean;
    onAction: (action: 'run' | 'open' | 'stop' | 'refresh') => void;
  }

  let { app, status, busy, onAction }: Props = $props();
  const fields = $derived(status ? [
    ['Display', status.displayName],
    ['Claim title', status.claimTitle],
    ['Claim', status.claimSlug],
    ['Repository', status.repository],
    ['Build context', status.buildContext],
    ['Dockerfile', status.dockerfile],
    ['Image', status.image],
    ['Container', status.containerName],
    ['Docker context', status.dockerContext ?? 'Unavailable'],
    ['State / health', status.state],
    ['Ports', `${status.hostPort} → ${status.containerPort}`],
    ['URL', status.url],
    ['Last action', status.lastAction],
  ] : []);
</script>

<section class="container-app-detail" aria-label={`${app.displayName} details`}>
  <header>
    <div>
      <p class="eyebrow">Container app</p>
      <h1>{app.displayName}</h1>
    </div>
    <span class="detail-state state-{status?.state ?? 'unknown'}">{busy ? 'Working…' : status?.state ?? 'Loading…'}</span>
  </header>
  <div class="container-app-detail-actions">
    <button class="primary" disabled={busy} onclick={() => onAction('run')}>Run</button>
    <button class="secondary" disabled={busy} onclick={() => onAction('open')}>Open App</button>
    <button class="secondary" disabled={busy} onclick={() => onAction('stop')}>Stop</button>
    <button class="secondary" disabled={busy} onclick={() => onAction('refresh')}>Refresh Status</button>
  </div>
  {#if status}
    <dl>
      {#each fields as field}
        <div><dt>{field[0]}</dt><dd>{field[1]}</dd></div>
      {/each}
    </dl>
    {#if status.error}<p class="container-app-error" role="alert">{status.error}</p>{/if}
  {:else}
    <p>Refreshing live container status…</p>
  {/if}
</section>
