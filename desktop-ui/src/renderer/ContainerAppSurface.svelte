<script lang="ts">
  import { onMount } from 'svelte';
  import type { ContainerAppId } from '../shared/contracts';

  let { appId, title }: { appId: ContainerAppId; title: string } = $props();
  let element: HTMLDivElement;
  let error = $state('');
  let loading = $state(true);
  let opening = $state(false);
  let openError = $state('');

  async function openOpenObserve(source?: 'http' | 'queue' | 'embeddings'): Promise<void> {
    opening = true;
    openError = '';
    try {
      await window.workingMemory.openObservability(source);
    } catch (cause) {
      openError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      opening = false;
    }
  }

  onMount(() => {
    const id = crypto.randomUUID();
    let active = true;
    const bounds = () => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const report = (cause: unknown) => {
      if (active) error = cause instanceof Error ? cause.message : String(cause);
    };
    const resize = () => {
      void window.workingMemory.resizeContainerAppSurface(id, bounds()).catch(report);
    };
    let visible = true;
    const updateVisibility = () => {
      // Native child views sit above HTML; hide them while app menus or dialogs are open.
      const next = !Array.from(document.querySelectorAll('[role="menu"], [role="dialog"], .document-tab-menu'))
        .some(overlay => overlay.checkVisibility());
      if (next === visible) return;
      visible = next;
      void window.workingMemory.setContainerAppSurfaceVisible(id, visible).catch(report);
    };
    void window.workingMemory.mountContainerAppSurface(appId, id, bounds())
      .then(() => { if (active) loading = false; }).catch(report);
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    const overlays = new MutationObserver(updateVisibility);
    overlays.observe(document.body, { childList: true, subtree: true, attributes: true });
    updateVisibility();
    window.addEventListener('resize', resize);
    window.addEventListener('scroll', resize, true);
    return () => {
      active = false;
      observer.disconnect();
      overlays.disconnect();
      window.removeEventListener('resize', resize);
      window.removeEventListener('scroll', resize, true);
      void window.workingMemory.closeContainerAppSurface(id).catch(cause => {
        console.error('Unable to close Container App dashboard:', cause);
      });
    };
  });
</script>

<section class="container-app-dashboard">
  <div class="container-app-dashboard-toolbar">
    <span>{title}</span>
    <button type="button" data-open="http" onclick={() => openOpenObserve('http')} disabled={opening}>HTTP logs</button>
    <button type="button" data-open="queue" onclick={() => openOpenObserve('queue')} disabled={opening}>Queue logs</button>
    <button type="button" data-open="embeddings" onclick={() => openOpenObserve('embeddings')} disabled={opening}>Embeddings logs</button>
    <button type="button" data-open="full" onclick={() => openOpenObserve()} disabled={opening}>
      {opening ? 'Opening OpenObserve...' : 'Open OpenObserve in a new window'}
    </button>
  </div>
  {#if openError}<p class="container-app-error" role="alert">{openError}</p>{/if}
  <div bind:this={element} class="container-app-frame" aria-label={`${title} dashboard`}>
    {#if error}
      <p role="alert">{error}</p>
    {:else if loading}
      <p role="status">Signing in to {title}...</p>
    {/if}
  </div>
</section>

<style>
  .container-app-dashboard { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .container-app-dashboard-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 8px 12px; border-bottom: 1px solid #d1ced0; }
  .container-app-dashboard-toolbar > span { margin-right: auto; }
  .container-app-dashboard > .container-app-frame { flex: 1; height: auto; }
</style>
