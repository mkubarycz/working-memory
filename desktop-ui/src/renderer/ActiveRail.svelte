<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type {
    PanelAction,
    PanelData,
    PanelNaniteRow,
    PanelTopic,
    PanelTopicsGroup,
    PanelWorkstream,
    PanelWorkstreamSection,
  } from '../../../src/panelData';
  import type { DesktopEnvironment } from '../shared/contracts';
  import { activeContextMenuItems, topicSlugFromOpenUri, type ActiveContextMenuItem } from './activeContextMenu';
  import {
    resizeActiveSections,
    type ActiveSectionBoundary,
    type ActiveSectionHeights,
  } from './activeSectionLayout';
  import { setResourceDragData } from './resourceDrag';
  import { setSubtreeExpanded, type ExpandableTreeNode } from './treeExpansion';
  import { workstreamColorClass } from './workstreamColor';

  interface Props {
    environments: DesktopEnvironment[];
    selectedEnvironment: DesktopEnvironment | null;
    environmentLoading: boolean;
    environmentError: string;
    data: PanelData | null;
    loading: boolean;
    error: string;
    onRefresh: () => void;
    onSettings: () => void;
    onCollapse: () => void;
    onOpen: (uri: string) => void;
    onToggleFocus: (workstream: string, topic: string) => void;
    onAction: (workstream: string, action: PanelAction) => void;
    onDiscoverEnvironments: () => Promise<void>;
    onSwitchEnvironment: (mcpUrl: string) => Promise<void>;
  }

  let {
    environments, selectedEnvironment, environmentLoading, environmentError,
    data, loading, error, onRefresh, onSettings, onCollapse, onOpen, onToggleFocus, onAction,
    onDiscoverEnvironments, onSwitchEnvironment,
  }: Props = $props();
  const expanded = new SvelteSet<string>();
  let seeded = $state(false);
  let menu = $state<{ x: number; y: number; workstream: string; items: ActiveContextMenuItem[] } | null>(null);
  let menuElement = $state<HTMLDivElement | null>(null);
  let sectionsElement = $state<HTMLDivElement | null>(null);
  let sectionHeights = $state<ActiveSectionHeights | null>(null);
  let environmentMenuOpen = $state(false);
  let sectionDrag: { boundary: ActiveSectionBoundary; startY: number; initial: ActiveSectionHeights } | null = null;

  const sections = $derived(
    (data?.items.filter((item): item is PanelWorkstreamSection => item.kind === 'workstream-section')) ?? [],
  );

  $effect(() => {
    if (seeded || sections.length === 0) return;
    seeded = true;
    for (const section of sections) {
      expanded.add(section.id);
      if (section.section === 'progress') {
        for (const workstream of section.workstreams) {
          setSubtreeExpanded(expanded, workstream, true);
        }
      }
    }
  });

  function toggle(node: ExpandableTreeNode, recursive = false): void {
    const nextExpanded = !expanded.has(node.id);
    if (recursive) setSubtreeExpanded(expanded, node, nextExpanded);
    else if (nextExpanded) expanded.add(node.id);
    else expanded.delete(node.id);
  }

  async function toggleEnvironmentMenu(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (environmentMenuOpen) {
      environmentMenuOpen = false;
      return;
    }
    await onDiscoverEnvironments();
    environmentMenuOpen = true;
  }

  async function chooseEnvironment(event: MouseEvent, mcpUrl: string): Promise<void> {
    event.stopPropagation();
    environmentMenuOpen = false;
    if (mcpUrl !== selectedEnvironment?.mcpUrl) await onSwitchEnvironment(mcpUrl);
  }

  async function openMenu(event: MouseEvent, workstream: string, items: ActiveContextMenuItem[]): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (items.length === 0) return;
    const targetRect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    menu = {
      x: event.clientX || targetRect.left + 24,
      y: event.clientY || targetRect.top + targetRect.height,
      workstream,
      items,
    };
    await tick();
    if (!menu || !menuElement) return;
    const menuRect = menuElement.getBoundingClientRect();
    menu = {
      ...menu,
      x: Math.max(4, Math.min(menu.x, window.innerWidth - menuRect.width - 4)),
      y: Math.max(4, Math.min(menu.y, window.innerHeight - menuRect.height - 4)),
    };
    menuElement.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  function runMenuItem(event: MouseEvent, item: ActiveContextMenuItem): void {
    event.stopPropagation();
    const workstream = menu?.workstream ?? '';
    if (!item.enabled) return;
    menu = null;
    if (item.kind === 'focus') onToggleFocus(workstream, item.topic);
    else onAction(workstream, item.action);
  }

  function navigateMenu(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      menu = null;
      return;
    }
    if (!menuElement || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menuElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function measuredSectionHeights(): ActiveSectionHeights | null {
    if (!sectionsElement) return null;
    const height = (section: keyof ActiveSectionHeights) =>
      sectionsElement?.querySelector<HTMLElement>(`.section-${section}`)?.getBoundingClientRect().height ?? 0;
    const measured = { queue: height('queue'), progress: height('progress'), backlog: height('backlog') };
    return Object.values(measured).every((value) => value > 0) ? measured : null;
  }

  function startSectionResize(boundary: ActiveSectionBoundary, event: PointerEvent): void {
    if (event.button !== 0) return;
    const initial = measuredSectionHeights();
    if (!initial) return;
    event.preventDefault();
    event.stopPropagation();
    menu = null;
    sectionHeights = initial;
    sectionDrag = { boundary, startY: event.clientY, initial };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    document.body.classList.add('resizing-active-sections');
  }

  function moveSectionResize(event: PointerEvent): void {
    if (!sectionDrag) return;
    sectionHeights = resizeActiveSections(
      sectionDrag.boundary,
      event.clientY - sectionDrag.startY,
      sectionDrag.initial,
    );
  }

  function finishSectionResize(): void {
    sectionDrag = null;
    document.body.classList.remove('resizing-active-sections');
  }

  function startResourceDrag(event: DragEvent, openUri: string, label: string): void {
    setResourceDragData(event.dataTransfer, openUri, label);
  }

  function resizeSectionWithKeyboard(boundary: ActiveSectionBoundary, event: KeyboardEvent): void {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const initial = measuredSectionHeights();
    if (!initial) return;
    event.preventDefault();
    const step = event.altKey ? 1 : event.shiftKey ? 32 : 8;
    const delta = event.key === 'Home' ? -10_000
      : event.key === 'End' ? 10_000
        : event.key === 'ArrowDown' ? step : -step;
    sectionHeights = resizeActiveSections(boundary, delta, initial);
  }
</script>

<svelte:window
  onclick={() => { menu = null; environmentMenuOpen = false; }}
  onkeydown={(event) => {
    if (event.key === 'Escape') { menu = null; environmentMenuOpen = false; }
  }}
/>

{#snippet alertBubble(count?: number, severity?: 'alert' | 'informational' | null)}
  {#if count && count > 0}
    <span class="active-alert" class:severe={severity === 'alert'} title="{count} open alert{count === 1 ? '' : 's'}">{count}</span>
  {/if}
{/snippet}

{#snippet nodeRow(node: PanelTopic | PanelNaniteRow, workstream: string, depth: number)}
  {@const children = node.kind === 'topic' ? node.children ?? [] : []}
  {@const open = expanded.has(node.id)}
  {@const topicSlug = node.kind === 'topic' ? topicSlugFromOpenUri(node.openUri) : ''}
  {@const menuItems = activeContextMenuItems(node.actions, node.kind === 'topic' ? { topic: topicSlug, focused: node.focused } : undefined)}
  <li class="active-tree-node" style="--tree-depth: {depth}">
    <div
      class="active-row"
      class:nanite={node.kind === 'nanite'}
      class:closed={node.kind === 'topic' && node.status === 'closed'}
      data-kind={node.kind}
      role="group"
      oncontextmenu={(event) => void openMenu(event, workstream, menuItems)}
    >
      {#if children.length > 0}
        <button
          class="active-twistie"
          data-expandable="true"
          aria-expanded={open}
          aria-label="{open ? 'Collapse' : 'Expand'} {node.label}"
          onclick={() => toggle(node)}
        ><span aria-hidden="true" class="codicon codicon-chevron-{open ? 'down' : 'right'}"></span></button>
      {:else}
        <span class="active-twistie-spacer"></span>
      {/if}
      <button
        class="active-open"
        title={node.tooltip}
        draggable="true"
        ondragstart={(event) => startResourceDrag(event, node.openUri, node.label)}
        onclick={() => onOpen(node.openUri)}
      >
        <span aria-hidden="true" class="codicon codicon-{node.icon}"></span>
        <span class="active-label">{node.label}</span>
        {#if node.kind === 'nanite'}
          <span class="active-description">{node.phase}</span>
        {/if}
      </button>
      {#if node.kind === 'topic'}
        {@render alertBubble(node.alertCount, node.alertSeverity)}
      {/if}
    </div>
    {#if children.length > 0 && open}
      <ul class="active-tree">
        {#each children as child (child.id)}
          {@render nodeRow(child, workstream, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

{#snippet topicGroup(group: PanelTopicsGroup, workstream: string)}
  {@const open = expanded.has(group.id)}
  <section class="active-group">
    <button
      class="active-group-header"
      disabled={!group.collapsible}
      data-expandable={group.collapsible ? 'true' : undefined}
      aria-expanded={group.collapsible ? open : undefined}
      aria-label={group.collapsible ? `${open ? 'Collapse' : 'Expand'} ${group.label}` : group.label}
      onclick={() => group.collapsible && toggle(group)}
    >
      <span aria-hidden="true" class="codicon codicon-chevron-{open ? 'down' : 'right'}"></span>
      <span aria-hidden="true" class="codicon codicon-{group.icon}"></span>
      <span>{group.label}</span>
    </button>
    {#if group.collapsible && open}
      <ul class="active-tree">
        {#each group.children as node (node.id)}
          {@render nodeRow(node, workstream, 0)}
        {/each}
      </ul>
    {/if}
  </section>
{/snippet}

{#snippet workstreamCard(workstream: PanelWorkstream, compact: boolean)}
  {@const open = expanded.has(workstream.id)}
  {@const hasDetails = workstream.focused_topics.length > 0 || workstream.children.length > 0}
  {@const menuItems = activeContextMenuItems(workstream.actions)}
  <article class="active-card {workstreamColorClass(workstream.id)}" class:compact data-workstream={workstream.slug ?? workstream.id}>
    <div class="active-card-header" role="group" oncontextmenu={(event) => void openMenu(event, workstream.slug ?? '', menuItems)}>
      {#if hasDetails}
        <button
          class="active-twistie"
          data-expandable="true"
          aria-expanded={open}
          aria-label="{open ? 'Collapse' : 'Expand'} {workstream.label}"
          onclick={() => toggle(workstream, true)}
        ><span aria-hidden="true" class="codicon codicon-chevron-{open ? 'down' : 'right'}"></span></button>
      {:else}
        <span class="active-twistie-spacer"></span>
      {/if}
      <button
        class="active-open workstream-open"
        title={workstream.tooltip}
        draggable="true"
        ondragstart={(event) => startResourceDrag(event, workstream.openUri, workstream.label)}
        onclick={() => onOpen(workstream.openUri)}
      >
        <span aria-hidden="true" class="codicon codicon-briefcase"></span>
        <span class="active-label">{workstream.label}</span>
      </button>
      {@render alertBubble(workstream.alertCount, workstream.alertSeverity)}
    </div>
    {#if hasDetails && open}
      <div class="active-card-body">
        {#each workstream.focused_topics as topic (topic.id)}
          <button
            class="focused-topic"
            title={topic.tooltip}
            draggable="true"
            ondragstart={(event) => startResourceDrag(event, topic.openUri, topic.label)}
            onclick={() => onOpen(topic.openUri)}
            oncontextmenu={(event) => void openMenu(event, workstream.slug ?? '', activeContextMenuItems(topic.actions, { topic: topicSlugFromOpenUri(topic.openUri), focused: topic.focused }))}
          >
            <span>{topic.label}</span>
            {@render alertBubble(topic.alertCount, topic.alertSeverity)}
          </button>
        {/each}
        {#each workstream.children as group (group.id)}
          {@render topicGroup(group, workstream.slug ?? '')}
        {/each}
      </div>
    {/if}
  </article>
{/snippet}

<div class="active-rail-inner">
  <header class="active-rail-header">
    <div class="mark">WM</div>
    <div class="environment-selector">
      <button
        class="environment-trigger"
        aria-haspopup="menu"
        aria-expanded={environmentMenuOpen}
        title="Switch Working Memory environment"
        onclick={(event) => void toggleEnvironmentMenu(event)}
      >
        <span aria-hidden="true" class="codicon codicon-server"></span>
        <span class="active-heading"><strong>{selectedEnvironment?.displayName ?? 'No server'}</strong><span>Working Memory</span></span>
        <span aria-hidden="true" class="codicon codicon-chevron-down" class:codicon-modifier-spin={environmentLoading}></span>
      </button>
      {#if environmentMenuOpen}
        <div
          class="environment-menu"
          role="menu"
          aria-label="Working Memory environments"
          tabindex="-1"
          onclick={(event) => event.stopPropagation()}
          onkeydown={(event) => event.stopPropagation()}
        >
          {#if environmentError}
            <p class="environment-state" role="alert">{environmentError}</p>
          {:else if environmentLoading}
            <p class="environment-state">Discovering servers…</p>
          {:else if environments.length === 0}
            <p class="environment-state">No healthy servers found.</p>
          {:else}
            {#each environments as environment (environment.id)}
              <button
                role="menuitemradio"
                aria-checked={environment.mcpUrl === selectedEnvironment?.mcpUrl}
                onclick={(event) => void chooseEnvironment(event, environment.mcpUrl)}
              >
                <span aria-hidden="true" class="codicon codicon-plug"></span>
                <span>{environment.displayName}</span>
                {#if environment.mcpUrl === selectedEnvironment?.mcpUrl}
                  <span aria-hidden="true" class="codicon codicon-check"></span>
                {/if}
              </button>
            {/each}
          {/if}
        </div>
      {/if}
    </div>
    <button class="active-header-button" title="Refresh Active" aria-label="Refresh Active" onclick={onRefresh}>
      <span aria-hidden="true" class="codicon codicon-refresh" class:codicon-modifier-spin={loading}></span>
    </button>
    <button class="active-header-button" title="Settings" aria-label="Settings" onclick={onSettings}>
      <span aria-hidden="true" class="codicon codicon-settings-gear"></span>
    </button>
    <button class="active-header-button" title="Collapse Active rail" aria-label="Collapse Active rail" onclick={onCollapse}>
      <span aria-hidden="true" class="codicon codicon-chevron-left"></span>
    </button>
  </header>

  <div
    bind:this={sectionsElement}
    class="active-sections"
    aria-label="Active workstreams"
    style={sectionHeights
      ? `grid-template-rows: ${sectionHeights.queue}px ${sectionHeights.progress}px minmax(76px, 1fr);`
      : undefined}
  >
    {#if error}<p class="active-error" role="alert">{error}</p>{/if}
    {#if !data && loading}<p class="active-empty">Loading active work…</p>{/if}
    {#each sections as section (section.id)}
      <section class="active-section section-{section.section}" aria-label={section.label}>
        <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
        <header
          class="active-section-header"
          class:resizable={section.section !== 'queue'}
          role={section.section !== 'queue' ? 'separator' : undefined}
          aria-label={section.section !== 'queue' ? `Resize ${section.label} section` : undefined}
          aria-orientation={section.section !== 'queue' ? 'horizontal' : undefined}
          tabindex={section.section !== 'queue' ? 0 : undefined}
          title={section.section !== 'queue' ? `Drag to resize ${section.label}` : undefined}
          onpointerdown={(event) => section.section !== 'queue' && startSectionResize(section.section, event)}
          onpointermove={moveSectionResize}
          onpointerup={finishSectionResize}
          onpointercancel={finishSectionResize}
          onkeydown={(event) => section.section !== 'queue' && resizeSectionWithKeyboard(section.section, event)}
        >
          <span>{section.label}</span><span>{section.workstreams.length}</span>
        </header>
        <div class="active-section-content">
          {#if section.workstreams.length === 0}
            <p class="active-empty">{section.emptyMessage}</p>
          {:else}
            {#each section.workstreams as workstream (workstream.id)}
              {@render workstreamCard(workstream, section.display === 'shelf')}
            {/each}
          {/if}
        </div>
      </section>
    {/each}
  </div>
</div>

{#if menu}
  <div
    bind:this={menuElement}
    class="active-context-menu"
    role="menu"
    aria-label="Row actions"
    tabindex="-1"
    style="left: {menu.x}px; top: {menu.y}px;"
    onclick={(event) => event.stopPropagation()}
    onkeydown={navigateMenu}
  >
    {#each menu.items as item}
      <button
        role="menuitem"
        disabled={!item.enabled}
        onclick={(event) => runMenuItem(event, item)}
      >
        <span aria-hidden="true" class="codicon codicon-{item.icon}"></span>
        <span>{item.title}</span>
      </button>
    {/each}
  </div>
{/if}