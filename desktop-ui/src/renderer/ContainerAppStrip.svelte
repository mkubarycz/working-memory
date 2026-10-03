<script lang="ts">
  import { tick } from 'svelte';
  import type { ContainerAppStatus } from '../shared/contracts';
  import type { ContainerAppItem } from './containerApps';

  interface Props {
    apps: ContainerAppItem[];
    statuses: Record<string, ContainerAppStatus | undefined>;
    busyAppId: string | null;
    onOpenDetail: (app: ContainerAppItem) => void;
    onAction: (app: ContainerAppItem, action: 'run' | 'open' | 'stop' | 'refresh') => void;
  }

  let { apps, statuses, busyAppId, onOpenDetail, onAction }: Props = $props();
  let openMenuId = $state<string | null>(null);
  let menuElement = $state<HTMLDivElement | null>(null);
  let menuButtonElement: HTMLButtonElement | null = null;

  function closeMenu(restoreFocus = false): void {
    const id = openMenuId;
    openMenuId = null;
    if (restoreFocus && id) void tick().then(() => menuButtonElement?.focus());
  }

  function act(app: ContainerAppItem, action: 'run' | 'open' | 'stop' | 'refresh'): void {
    closeMenu();
    onAction(app, action);
  }

  async function toggleMenu(app: ContainerAppItem, trigger: HTMLButtonElement): Promise<void> {
    if (openMenuId === app.id) {
      closeMenu(true);
      return;
    }
    menuButtonElement = trigger;
    openMenuId = app.id;
    await tick();
    menuElement?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  function navigateMenu(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = [...(menuElement?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }
</script>

<svelte:window
  onclick={() => closeMenu()}
/>

<nav class="container-app-strip" aria-label="Container apps">
  {#each apps as app (app.id)}
    {@const status = statuses[app.id]}
    <div class="container-app-item" data-app-id={app.id}>
      <button class="container-app-primary" onclick={() => onOpenDetail(app)} aria-label={`Open ${app.displayName} details`}>
        <span aria-hidden="true" class="codicon codicon-{app.icon}"></span>
        <span>{app.displayName}</span>
        <span class="container-app-state state-{status?.state ?? 'unknown'}">{busyAppId === app.id ? 'Working…' : status?.state ?? 'Status unknown'}</span>
      </button>
      <button
        class="container-app-menu-button"
        aria-label={`${app.displayName} actions`}
        aria-haspopup="menu"
        aria-expanded={openMenuId === app.id}
        onclick={(event) => { event.stopPropagation(); void toggleMenu(app, event.currentTarget); }}
      >…</button>
      {#if openMenuId === app.id}
        <div
          bind:this={menuElement}
          class="container-app-menu"
          role="menu"
          tabindex="-1"
          aria-label={`${app.displayName} actions`}
          onclick={(event) => event.stopPropagation()}
          onkeydown={navigateMenu}
        >
          <button role="menuitem" disabled={busyAppId === app.id} onclick={() => act(app, 'run')}>Run</button>
          <button role="menuitem" disabled={busyAppId === app.id} onclick={() => act(app, 'open')}>Open App</button>
          <button role="menuitem" disabled={busyAppId === app.id} onclick={() => act(app, 'stop')}>Stop</button>
          <button role="menuitem" disabled={busyAppId === app.id} onclick={() => act(app, 'refresh')}>Refresh Status</button>
        </div>
      {/if}
    </div>
  {/each}
</nav>
