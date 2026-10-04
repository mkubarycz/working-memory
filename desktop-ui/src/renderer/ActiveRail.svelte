<script lang="ts">
  import { tick } from 'svelte';
  import { SvelteSet } from 'svelte/reactivity';
  import type {
    PanelAction,
    PanelData,
    PanelTopic,
    PanelTopicsGroup,
    PanelWorkstream,
    PanelWorkstreamSection,
  } from '../../../src/panelData';
  import type { DesktopEnvironment, PreparedResourceDrag } from '../shared/contracts';
  import {
    activeContextMenuItems,
    topicSlugFromOpenUri,
    type ActiveContextMenuItem,
    type ActiveMoveTarget,
  } from './activeContextMenu';
  import {
    resizeActiveSections,
    type ActiveSectionBoundary,
    type ActiveSectionHeights,
  } from './activeSectionLayout';
  import { setResourceDragData } from './resourceDrag';
  import { attachTreeConnector } from './treeConnector';
  import { setNodeAndChildrenExpanded, setSubtreeExpanded, type ExpandableTreeNode } from './treeExpansion';
  import { workstreamColorClass } from './workstreamColor';
  import { workstreamDropIndex } from './workstreamReorder';
  import { planTopicTransfer, type TopicDragSource, type TopicTransferRequest } from './topicTransfer';

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
    onReorder: (slug: string, section: PanelWorkstreamSection['section'], index: number) => Promise<void>;
    onTransferTopic: (request: TopicTransferRequest) => void;
    onReparentTopic: (slug: string, parent: string | null) => void;
    onDiscoverEnvironments: () => Promise<void>;
    onSwitchEnvironment: (mcpUrl: string) => Promise<void>;
  }

  let {
    environments, selectedEnvironment, environmentLoading, environmentError,
    data, loading, error, onRefresh, onSettings, onCollapse, onOpen, onToggleFocus, onAction, onReorder, onTransferTopic,
    onReparentTopic,
    onDiscoverEnvironments, onSwitchEnvironment,
  }: Props = $props();
  const expanded = new SvelteSet<string>();
  let seeded = $state(false);
  let menu = $state<{
    x: number;
    y: number;
    workstream: string;
    items: ActiveContextMenuItem[];
    submenuToLeft: boolean;
  } | null>(null);
  let menuElement = $state<HTMLDivElement | null>(null);
  let sectionsElement = $state<HTMLDivElement | null>(null);
  let sectionHeights = $state<ActiveSectionHeights | null>(null);
  let environmentMenuOpen = $state(false);
  let sectionDrag: { boundary: ActiveSectionBoundary; startY: number; initial: ActiveSectionHeights } | null = null;
  let activeDrag = $state<
    | ({ kind: 'topic' } & TopicDragSource)
    | { kind: 'workstream'; slug: string; section: PanelWorkstreamSection['section'] }
    | null
  >(null);
  const topicDrag = $derived(activeDrag?.kind === 'topic' ? activeDrag : null);
  const workstreamDrag = $derived(activeDrag?.kind === 'workstream' ? activeDrag : null);
  let topicDropTarget = $state<string | null>(null);
  let topicReparentTarget = $state<string | null>(null);
  let dropTarget = $state<{ section: PanelWorkstreamSection['section']; index: number } | null>(null);
  const preparedResourceDrags = new Map<string, PreparedResourceDrag>();
  const pendingResourceDrags = new Map<string, number>();
  let dragPreparationGeneration = 0;
  let nativeDragFilePath = $state<string | null>(null);
  let draggingWorkstreamSlug = $state<string | null>(null);

  const sections = $derived(
    (data?.items.filter((item): item is PanelWorkstreamSection => item.kind === 'workstream-section')) ?? [],
  );
  const moveTargets = $derived(sections.flatMap((section) =>
    section.workstreams.flatMap((workstream): ActiveMoveTarget[] =>
      workstream.slug ? [{ slug: workstream.slug, title: workstream.label }] : [])));

  $effect(() => {
    if (seeded || sections.length === 0) return;
    seeded = true;
    for (const section of sections) {
      if (section.section === 'progress') {
        for (const workstream of section.workstreams) {
          setSubtreeExpanded(expanded, workstream, true);
        }
      }
    }
  });

  $effect(() => {
    selectedEnvironment?.mcpUrl;
    const visibleSections = sections;
    dragPreparationGeneration += 1;
    preparedResourceDrags.clear();
    pendingResourceDrags.clear();
    for (const section of visibleSections) {
      for (const workstream of section.workstreams) {
        prepareResourceDrag(workstream.openUri, workstream.label);
        for (const topic of workstream.focused_topics) prepareTopicDragTree(topic);
        for (const group of workstream.children) {
          for (const topic of group.children) prepareTopicDragTree(topic);
        }
      }
    }
  });

  $effect(() => window.workingMemory.onResourceDragResult((result) => {
    if (result.filePath !== nativeDragFilePath) return;
    if (result.status === 'failed') {
      nativeDragFilePath = null;
      activeDrag = null;
      topicDropTarget = null;
      dropTarget = null;
      draggingWorkstreamSlug = null;
      console.error('Unable to drag Working Memory context:', result.error);
    }
  }));

  function toggle(node: ExpandableTreeNode, recursive = false): void {
    const nextExpanded = !expanded.has(node.id);
    if (recursive) setSubtreeExpanded(expanded, node, nextExpanded);
    else if (nextExpanded) expanded.add(node.id);
    else expanded.delete(node.id);
  }

  function toggleWorkstream(workstream: PanelWorkstream): void {
    if (expanded.has(workstream.id)) expanded.delete(workstream.id);
    else setNodeAndChildrenExpanded(expanded, workstream);
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
      submenuToLeft: false,
    };
    await tick();
    if (!menu || !menuElement) return;
    const menuRect = menuElement.getBoundingClientRect();
    const submenuRects = [...menuElement.querySelectorAll<HTMLElement>('.active-context-submenu')]
      .map((submenu) => submenu.getBoundingClientRect());
    const submenuWidth = Math.max(0, ...submenuRects.map((rect) => rect.width));
    const contentHeight = Math.max(menuRect.height, ...submenuRects.map((rect) => rect.height));
    const x = Math.max(4, Math.min(menu.x, window.innerWidth - menuRect.width - 4));
    menu = {
      ...menu,
      x,
      y: Math.max(4, Math.min(menu.y, window.innerHeight - contentHeight - 4)),
      submenuToLeft: submenuWidth > 0 && x + menuRect.width + submenuWidth + 8 > window.innerWidth,
    };
    menuElement.querySelector<HTMLButtonElement>(
      ':scope > .active-context-menu-entry > button:not(:disabled)',
    )?.focus();
  }

  function runMenuItem(event: MouseEvent, item: ActiveContextMenuItem): void {
    event.stopPropagation();
    const workstream = menu?.workstream ?? '';
    if (!item.enabled) return;
    if (item.kind === 'move') return;
    menu = null;
    if (item.kind === 'focus') onToggleFocus(workstream, item.topic);
    else onAction(workstream, item.action);
  }

  function moveTopicFromMenu(
    event: MouseEvent,
    item: Extract<ActiveContextMenuItem, { kind: 'move' }>,
    targetWorkstream: string,
  ): void {
    event.stopPropagation();
    const sourceWorkstream = menu?.workstream ?? '';
    const request = planTopicTransfer(
      { slug: item.topic, sourceWorkstream },
      targetWorkstream,
      true,
    );
    if (!request) return;
    menu = null;
    onTransferTopic(request);
  }

  function openMoveSubmenu(event: KeyboardEvent): void {
    if (event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement)
      .closest('.active-context-menu-entry')
      ?.querySelector<HTMLButtonElement>('.active-context-submenu button:not(:disabled)')
      ?.focus();
  }

  function navigateMoveSubmenu(event: KeyboardEvent): void {
    const submenu = (event.currentTarget as HTMLElement).closest('.active-context-submenu');
    if (!submenu) return;
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      event.stopPropagation();
      submenu.closest('.active-context-menu-entry')
        ?.querySelector<HTMLButtonElement>(':scope > button')
        ?.focus();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const items = [...submenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    if (items.length === 0) return;
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : event.key === 'ArrowDown' ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function navigateMenu(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      menu = null;
      return;
    }
    if (!menuElement || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const items = [...menuElement.querySelectorAll<HTMLButtonElement>(
      ':scope > .active-context-menu-entry > button:not(:disabled)',
    )];
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

  function prepareTopicDragTree(topic: PanelTopic, generation = dragPreparationGeneration): void {
    prepareResourceDrag(topic.openUri, topic.label, generation);
    for (const child of topic.children ?? []) prepareTopicDragTree(child, generation);
  }

  function prepareResourceDrag(
    openUri: string,
    label: string,
    generation = dragPreparationGeneration,
  ): void {
    if (
      preparedResourceDrags.has(openUri)
      || pendingResourceDrags.get(openUri) === generation
    ) return;
    pendingResourceDrags.set(openUri, generation);
    void window.workingMemory.prepareResourceDrag(openUri, label)
      .then((prepared) => {
        if (generation === dragPreparationGeneration) {
          preparedResourceDrags.set(openUri, prepared);
        }
      })
      .catch((error) => console.error('Unable to prepare Working Memory drag context:', error))
      .finally(() => {
        if (pendingResourceDrags.get(openUri) === generation) {
          pendingResourceDrags.delete(openUri);
        }
      });
  }

  function startResourceDrag(event: DragEvent, openUri: string, label: string): void {
    const prepared = preparedResourceDrags.get(openUri);
    setResourceDragData(event.dataTransfer, openUri, label, prepared);
    if (!prepared) return;
    event.preventDefault();
    nativeDragFilePath = prepared.filePath;
    window.workingMemory.startResourceDrag(prepared);
  }

  function startTopicDrag(
    event: DragEvent,
    slug: string,
    workstream: string,
    openUri: string,
    label: string,
  ): void {
    event.stopPropagation();
    activeDrag = { kind: 'topic', slug, sourceWorkstream: workstream };
    dropTarget = null;
    startResourceDrag(event, openUri, label);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove';
  }

  function finishTopicDrag(): void {
    if (activeDrag?.kind === 'topic') activeDrag = null;
    nativeDragFilePath = null;
    topicDropTarget = null;
    topicReparentTarget = null;
  }

  function updateTopicReparentTarget(event: DragEvent, parent: string | null): void {
    if (!topicDrag || topicDrag.slug === parent) return;
    event.preventDefault();
    event.stopPropagation();
    topicReparentTarget = parent ?? 'root';
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  }

  function dropTopicOnParent(event: DragEvent, parent: string | null): void {
    if (!topicDrag || topicDrag.slug === parent) return;
    event.preventDefault();
    event.stopPropagation();
    const slug = topicDrag.slug;
    finishTopicDrag();
    onReparentTopic(slug, parent);
  }

  function startWorkstreamDrag(
    event: DragEvent,
    workstream: PanelWorkstream,
    section: PanelWorkstreamSection['section'],
  ): void {
    const slug = workstream.slug ?? '';
    if (!slug) return;
    event.stopPropagation();
    activeDrag = { kind: 'workstream', slug, section };
    draggingWorkstreamSlug = slug;
    topicDropTarget = null;
    startResourceDrag(event, workstream.openUri, workstream.label);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  function finishWorkstreamDrag(): void {
    if (activeDrag?.kind === 'workstream') activeDrag = null;
    nativeDragFilePath = null;
    draggingWorkstreamSlug = null;
    dropTarget = null;
  }

  function clearExternalDragVisual(event: DragEvent): void {
    if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return;
    draggingWorkstreamSlug = null;
  }

  function clearCompletedNativeDrag(event: PointerEvent): void {
    if (event.buttons !== 0 || !nativeDragFilePath) return;
    nativeDragFilePath = null;
    activeDrag = null;
    topicDropTarget = null;
    dropTarget = null;
    draggingWorkstreamSlug = null;
  }

  function updateTopicDropTarget(event: DragEvent, targetWorkstream: string): void {
    if (!planTopicTransfer(topicDrag, targetWorkstream, event.metaKey)) return;
    event.preventDefault();
    event.stopPropagation();
    topicDropTarget = targetWorkstream;
    if (event.dataTransfer) event.dataTransfer.dropEffect = event.metaKey ? 'move' : 'copy';
  }

  function dropTopic(event: DragEvent, targetWorkstream: string): void {
    const request = planTopicTransfer(topicDrag, targetWorkstream, event.metaKey);
    if (!request) return;
    event.preventDefault();
    event.stopPropagation();
    finishTopicDrag();
    onTransferTopic(request);
  }

  function updateDropTarget(
    event: DragEvent,
    section: PanelWorkstreamSection['section'],
  ): void {
    if (!workstreamDrag) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const boundaries = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.active-card')]
      .map((card) => {
        const bounds = card.querySelector<HTMLElement>('.active-card-header')?.getBoundingClientRect()
          ?? card.getBoundingClientRect();
        return { top: bounds.top, height: bounds.height };
      });
    dropTarget = { section, index: workstreamDropIndex(boundaries, event.clientY) };
  }

  async function dropWorkstream(event: DragEvent, section: PanelWorkstreamSection['section']): Promise<void> {
    if (!workstreamDrag || dropTarget?.section !== section) return;
    event.preventDefault();
    const { slug } = workstreamDrag;
    const { index } = dropTarget;
    finishWorkstreamDrag();
    await onReorder(slug, section, index);
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
  onpointermove={clearCompletedNativeDrag}
  onkeydown={(event) => {
    if (event.key === 'Escape') { menu = null; environmentMenuOpen = false; }
  }}
/>

{#snippet alertBubble(count?: number, severity?: 'alert' | 'informational' | null)}
  {#if count && count > 0}
    <span class="active-alert" class:severe={severity === 'alert'} title="{count} open alert{count === 1 ? '' : 's'}">{count}</span>
  {/if}
{/snippet}

{#snippet nodeRow(node: PanelTopic, workstream: string, depth: number)}
  {@const children = node.children ?? []}
  {@const open = expanded.has(node.id)}
  {@const topicSlug = topicSlugFromOpenUri(node.openUri)}
  {@const menuItems = activeContextMenuItems(node.actions, {
    topic: topicSlug,
    focused: node.focused,
    sourceWorkstream: workstream,
    moveTargets,
  })}
  <li class="active-tree-node" class:expanded={children.length > 0 && open} style="--tree-depth: {depth}">
    <div
      class="active-row"
      class:closed={node.status === 'closed'}
      class:topic-reparent-target={topicReparentTarget === topicSlug}
      data-kind={node.kind}
      role="group"
      ondragenter={(event) => updateTopicReparentTarget(event, topicSlug)}
      ondragover={(event) => updateTopicReparentTarget(event, topicSlug)}
      ondrop={(event) => dropTopicOnParent(event, topicSlug)}
      oncontextmenu={(event) => void openMenu(event, workstream, menuItems)}
    >
      {#if children.length > 0}
        <button
          class="graph-node-control"
          data-expandable="true"
          aria-expanded={open}
          aria-label="{open ? 'Collapse' : 'Expand'} {node.label}"
          onclick={() => toggle(node)}
        ><span aria-hidden="true" class="graph-node-dot"></span></button>
      {:else}
        <span class="graph-node-control graph-node-passive" aria-hidden="true"><span class="graph-node-dot"></span></span>
      {/if}
      <button
        class="active-open"
        title={node.tooltip}
        draggable="true"
        onpointerdown={() => prepareResourceDrag(node.openUri, node.label)}
        ondragstart={(event) => startTopicDrag(event, topicSlug, workstream, node.openUri, node.label)}
        ondragend={finishTopicDrag}
        onclick={() => onOpen(node.openUri)}
      >
        <span aria-hidden="true" class="codicon codicon-{node.icon}"></span>
        <span class="active-label">{node.label}</span>
      </button>
      {@render alertBubble(node.alertCount, node.alertSeverity)}
    </div>
    {#if children.length > 0 && open}
      <ul class="active-tree branch-tree">
        {#each children as child (child.id)}
          {@render nodeRow(child, workstream, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

{#snippet topicGroup(group: PanelTopicsGroup, workstream: string)}
  {@const open = expanded.has(group.id)}
  <section
    class="active-group"
    role="group"
    class:expanded={!group.collapsible || open}
    class:topic-root-target={topicReparentTarget === 'root'}
    ondragenter={(event) => updateTopicReparentTarget(event, null)}
    ondragover={(event) => updateTopicReparentTarget(event, null)}
    ondrop={(event) => dropTopicOnParent(event, null)}
  >
    <div class="active-group-header">
      {#if group.collapsible}
        <button
          class="graph-node-control"
          data-expandable="true"
          aria-expanded={open}
          aria-label="{open ? 'Collapse' : 'Expand'} {group.label}"
          onclick={() => toggle(group)}
        ><span aria-hidden="true" class="graph-node-dot"></span></button>
      {:else}
        <span class="graph-node-control graph-node-passive" aria-hidden="true"><span class="graph-node-dot"></span></span>
      {/if}
      <span aria-hidden="true" class="codicon codicon-{group.icon}"></span>
      <span>{group.label}</span>
    </div>
    {#if !group.collapsible || open}
      <ul class="active-tree branch-tree">
        {#each group.children as node (node.id)}
          {@render nodeRow(node, workstream, 0)}
        {/each}
      </ul>
    {/if}
  </section>
{/snippet}

{#snippet workstreamCard(workstream: PanelWorkstream, sectionStatus: PanelWorkstreamSection['section'], compact: boolean)}
  {@const open = expanded.has(workstream.id)}
  {@const hasDetails = workstream.focused_topics.length > 0 || workstream.children.length > 0}
  {@const expandable = sectionStatus === 'progress' && hasDetails}
  {@const menuItems = activeContextMenuItems(workstream.actions)}
  <article
    class="active-card {workstreamColorClass(workstream.id)}"
    class:compact
    class:summary={sectionStatus !== 'progress'}
    class:dragging={draggingWorkstreamSlug === workstream.slug}
    class:topic-drop-target={topicDropTarget === workstream.slug}
    data-section-status={sectionStatus}
    data-workstream={workstream.slug ?? workstream.id}
    ondragenter={(event) => updateTopicDropTarget(event, workstream.slug ?? '')}
    ondragover={(event) => updateTopicDropTarget(event, workstream.slug ?? '')}
    ondragleave={(event) => {
      if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) topicDropTarget = null;
    }}
    ondrop={(event) => dropTopic(event, workstream.slug ?? '')}
  >
    <div
      class="active-card-header"
      role="group"
      oncontextmenu={(event) => void openMenu(event, workstream.slug ?? '', menuItems)}
    >
      {#if expandable}
        <button
          class="active-twistie"
          data-expandable="true"
          aria-expanded={open}
          aria-label="{open ? 'Collapse' : 'Expand'} {workstream.label}"
          onclick={() => toggleWorkstream(workstream)}
        ><span aria-hidden="true" class="codicon codicon-chevron-{open ? 'down' : 'right'}"></span></button>
      {:else if sectionStatus === 'progress'}
        <span class="active-twistie-spacer"></span>
      {/if}
      <button
        class="active-open workstream-open"
        title={workstream.tooltip}
        draggable="true"
        onpointerdown={() => prepareResourceDrag(workstream.openUri, workstream.label)}
        ondragstart={(event) => startWorkstreamDrag(event, workstream, sectionStatus)}
        ondragend={finishWorkstreamDrag}
        onclick={() => onOpen(workstream.openUri)}
      >
        <span aria-hidden="true" class="codicon codicon-briefcase"></span>
        <span class="active-label">{workstream.label}</span>
      </button>
      {@render alertBubble(workstream.alertCount, workstream.alertSeverity)}
    </div>
    {#if expandable && open}
      <div class="active-card-body">
        {#if workstream.focused_topics.length > 0}
          <section class="pinned-topics" aria-label={`Pinned topics in ${workstream.label}`}>
            {#each workstream.focused_topics as topic (topic.id)}
              {@const topicSlug = topicSlugFromOpenUri(topic.openUri)}
              <div
                class="focused-topic"
                role="group"
                oncontextmenu={(event) => void openMenu(event, workstream.slug ?? '', activeContextMenuItems(topic.actions, {
                  topic: topicSlug,
                  focused: topic.focused,
                  sourceWorkstream: workstream.slug ?? '',
                  moveTargets,
                }))}
              >
                <button
                  class="focused-topic-pin"
                  title="Unpin from workstream"
                  aria-label="Unpin {topic.label} from {workstream.label}"
                  onclick={(event) => {
                    event.stopPropagation();
                    onToggleFocus(workstream.slug ?? '', topicSlug);
                  }}
                ><span aria-hidden="true" class="codicon codicon-pinned"></span></button>
                <button
                  class="focused-topic-open"
                  title={topic.tooltip}
                  draggable="true"
                  onpointerdown={() => prepareResourceDrag(topic.openUri, topic.label)}
                  ondragstart={(event) => startTopicDrag(event, topicSlug, workstream.slug ?? '', topic.openUri, topic.label)}
                  ondragend={finishTopicDrag}
                  onclick={() => onOpen(topic.openUri)}
                >
                  <span aria-hidden="true" class="codicon codicon-{topic.icon}"></span>
                  <span class="active-label">{topic.label}</span>
                  {@render alertBubble(topic.alertCount, topic.alertSeverity)}
                </button>
              </div>
            {/each}
          </section>
        {/if}
        {#if workstream.children.length > 0}
          <div class="topic-tree" use:attachTreeConnector>
            {#each workstream.children as group (group.id)}
              {@render topicGroup(group, workstream.slug ?? '')}
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </article>
{/snippet}

<div
  class="active-rail-inner"
  role="region"
  aria-label="Active workstreams"
  ondragleave={clearExternalDragVisual}
>
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
        <span class="active-heading">
          <strong>{selectedEnvironment?.displayName ?? 'No server'}</strong>
          <span>Working Memory</span>
        </span>
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
    <button class="active-header-button" title="Restart to apply latest build" aria-label="Restart Working Memory" onclick={onRefresh}>
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
      <section class="active-section section-{section.section}" class:drop-target={dropTarget?.section === section.section} aria-label={section.label}>
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
        <div
          class="active-section-content"
          role="group"
          aria-label={`${section.label} workstreams`}
          ondragenter={(event) => updateDropTarget(event, section.section)}
          ondragover={(event) => updateDropTarget(event, section.section)}
          ondrop={(event) => void dropWorkstream(event, section.section)}
        >
          {#if section.workstreams.length === 0}
            {#if dropTarget?.section === section.section}
              <div class="active-drop-indicator" aria-hidden="true"></div>
            {:else}
              <p class="active-empty">{section.emptyMessage}</p>
            {/if}
          {:else}
            {#each section.workstreams as workstream, index (workstream.id)}
              {#if dropTarget?.section === section.section && dropTarget.index === index}
                <div class="active-drop-indicator" aria-hidden="true"></div>
              {/if}
              {@render workstreamCard(workstream, section.section, section.display === 'shelf')}
            {/each}
            {#if dropTarget?.section === section.section && dropTarget.index === section.workstreams.length}
              <div class="active-drop-indicator" aria-hidden="true"></div>
            {/if}
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
      <div class="active-context-menu-entry">
        <button
          role="menuitem"
          aria-haspopup={item.kind === 'move' ? 'menu' : undefined}
          disabled={!item.enabled}
          onclick={(event) => runMenuItem(event, item)}
          onkeydown={item.kind === 'move' ? openMoveSubmenu : undefined}
        >
          <span aria-hidden="true" class="codicon codicon-{item.icon}"></span>
          <span>{item.title}</span>
          {#if item.kind === 'move'}
            <span aria-hidden="true" class="codicon codicon-chevron-right active-context-submenu-arrow"></span>
          {/if}
        </button>
        {#if item.kind === 'move' && item.enabled}
          <div
            class="active-context-submenu"
            class:submenu-left={menu.submenuToLeft}
            role="menu"
            aria-label="Move topic tree to workstream"
            tabindex="-1"
            onkeydown={navigateMoveSubmenu}
          >
            {#each item.targets as target (target.slug)}
              <button
                role="menuitem"
                onclick={(event) => moveTopicFromMenu(event, item, target.slug)}
              >
                <span aria-hidden="true" class="codicon codicon-briefcase"></span>
                <span>{target.title}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}