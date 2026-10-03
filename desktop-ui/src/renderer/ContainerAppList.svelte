<script lang="ts">
  import type { ContainerAppStatus } from '../shared/contracts';
  import type { ContainerAppItem } from './containerApps';

  interface Props {
    apps: ContainerAppItem[];
    statuses: Record<string, ContainerAppStatus | undefined>;
    selectedId: string | null;
    onSelect: (app: ContainerAppItem) => void;
  }

  let { apps, statuses, selectedId, onSelect }: Props = $props();
</script>

<nav class="container-app-list" aria-label="Registered Container Apps">
  {#if apps.length === 0}
    <p class="container-app-list-empty">No Container Apps are registered.</p>
  {:else}
    {#each apps as app (app.id)}
      {@const status = statuses[app.id]}
      <button
        class="container-app-list-item"
        class:selected={selectedId === app.id}
        aria-current={selectedId === app.id ? 'page' : undefined}
        onclick={() => onSelect(app)}
      >
        <span aria-hidden="true" class="codicon codicon-{app.icon}"></span>
        <span class="container-app-list-label">{app.displayName}</span>
        <span class="container-app-state state-{status?.state ?? 'unknown'}">
          {status?.state ?? 'unknown'}
        </span>
      </button>
    {/each}
  {/if}
</nav>
