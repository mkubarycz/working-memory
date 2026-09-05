<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import type { WorkstreamVM, TreeTopicVM, TreeNaniteVM, AlertVM } from './types';
  import type { SaveState } from './types';
  import { defaultExpandedIds, cascadeExpandIds, type ExpandableNode } from './treeExpansion';
  import { sortTreeChildren } from './treeSort';
  import SaveStatus from './SaveStatus.svelte';
  import AlertCallouts from './AlertCallouts.svelte';

  interface Props {
    ws: WorkstreamVM;
    saveState: SaveState;
    onSave: (patch: { title?: string; status?: string }) => void;
    onOpenTopic: (slug: string) => void;
    onOpenNanite: (id: string) => void;
    onInvoke: (command: string, args: unknown[]) => void;
    onTogglePin: (slug: string) => void;
    onSetAlertStatus: (id: string, status: AlertVM['status']) => void;
  }

  let {
    ws,
    saveState,
    onSave,
    onOpenTopic,
    onOpenNanite,
    onInvoke,
    onTogglePin,
    onSetAlertStatus,
  }: Props = $props();

  const STATUSES = ['queue', 'progress', 'backlog', 'closed'];

  // How many EXTRA levels a single expand cascades open (children + grandchildren).
  const CASCADE_LEVELS = 2;

  // Per-node expansion state, keyed by the node's stable id. Absent = collapsed.
  // Seeded to the top-level groups so only the first level of topics is visible
  // by default; deeper subtrees stay collapsed until expanded.
  const expanded = new SvelteSet<string>();

  // Re-seed defaults only on a fresh document load (slug change), not on every
  // data echo, so the user's manual expand/collapse survives re-renders.
  let seededFor = $state<string | null>(null);
  $effect(() => {
    const key = ws.slug ?? ws.title;
    if (key === seededFor) {
      return;
    }
    seededFor = key;
    expanded.clear();
    for (const id of defaultExpandedIds(ws.tree)) {
      expanded.add(id);
    }
  });

  function isExpanded(id: string): boolean {
    return expanded.has(id);
  }

  function toggleExpand(node: ExpandableNode): void {
    if (expanded.has(node.id)) {
      // Collapse just this node; its subtree hides because the parent is closed.
      expanded.delete(node.id);
    } else {
      // Expanding cascades two more levels of descendants open in one action.
      for (const id of cascadeExpandIds(node, CASCADE_LEVELS)) {
        expanded.add(id);
      }
    }
  }

  // --- Custom right-click context menu (webviews get no native tree menu) ---
  interface MenuItem {
    label: string;
    icon: string;
    disabled: boolean;
    run: () => void;
  }

  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let menuEl = $state<HTMLElement | undefined>();

  function topicMenu(node: TreeTopicVM): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: node.pinned ? 'Unpin from Workstream' : 'Pin to Workstream',
        icon: node.pinned ? 'pinned' : 'pin',
        disabled: false,
        run: () => onTogglePin(node.slug),
      },
    ];
    for (const a of node.actions) {
      items.push({
        label: a.title,
        icon: a.icon,
        disabled: !a.enabled,
        run: () => onInvoke(a.command, a.args),
      });
    }
    return items;
  }

  function naniteMenu(node: TreeNaniteVM): MenuItem[] {
    return node.actions.map((a) => ({
      label: a.title,
      icon: a.icon,
      disabled: !a.enabled,
      run: () => onInvoke(a.command, a.args),
    }));
  }

  function openMenu(event: MouseEvent, items: MenuItem[]): void {
    event.preventDefault();
    event.stopPropagation();
    if (items.length === 0) {
      menu = null;
      return;
    }
    // Clamp so the menu stays on-screen (rough size estimate is fine — the box
    // is small and the clamp only nudges it away from the far edges).
    const estWidth = 220;
    const estHeight = items.length * 28 + 8;
    const x = Math.min(event.clientX, window.innerWidth - estWidth - 4);
    const y = Math.min(event.clientY, window.innerHeight - estHeight - 4);
    menu = { x: Math.max(4, x), y: Math.max(4, y), items };
  }

  function closeMenu(): void {
    menu = null;
  }

  function runItem(item: MenuItem): void {
    if (item.disabled) {
      return;
    }
    item.run();
    closeMenu();
  }

  function onWindowClick(event: MouseEvent): void {
    if (
      menu &&
      menuEl &&
      event.target instanceof Element &&
      menuEl.contains(event.target)
    ) {
      return;
    }
    closeMenu();
  }

  function onWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      closeMenu();
    }
  }

  function onTitleInput(event: Event): void {
    ws.title = (event.currentTarget as HTMLInputElement).value;
    onSave({ title: ws.title });
  }

  function onStatusChange(event: Event): void {
    ws.status = (event.currentTarget as HTMLSelectElement).value;
    onSave({ status: ws.status });
  }

  function fmtTs(ts: number): string {
    if (!ts) {
      return '—';
    }
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return String(ts);
    }
  }
</script>

<svelte:window onclick={onWindowClick} onkeydown={onWindowKeydown} />

<header class="head">
  {#if ws.editable}
    <input
      class="title-input"
      value={ws.title}
      oninput={onTitleInput}
      aria-label="Workstream title"
    />
  {:else}
    <h1 class="title">{ws.title}</h1>
  {/if}
  <SaveStatus state={saveState} />
</header>

<section class="attrs" aria-label="Workstream attributes">
  <div class="attr">
    <span class="k">Title</span>
    <span class="v">{ws.title}</span>
  </div>
  <div class="attr">
    <span class="k">Slug</span>
    <span class="v mono">{ws.slug ?? '—'}</span>
  </div>
  <div class="attr">
    <span class="k">Status</span>
    <span class="v">
      {#if ws.editable}
        <select value={ws.status} onchange={onStatusChange} aria-label="Status">
          {#each STATUSES as s}
            <option value={s}>{s}</option>
          {/each}
        </select>
      {:else}
        {ws.status}
      {/if}
    </span>
  </div>
  <div class="attr">
    <span class="k">Created</span>
    <span class="v">{fmtTs(ws.createdAt)}</span>
  </div>
  <div class="attr">
    <span class="k">Updated</span>
    <span class="v">{fmtTs(ws.updatedAt)}</span>
  </div>
  <div class="attr">
    <span class="k">Resource version</span>
    <span class="v mono">{ws.resourceVersion}</span>
  </div>
  <div class="attr wide">
    <span class="k">Closure</span>
    <span class="v">{ws.closure?.trim() ? ws.closure : '—'}</span>
  </div>
</section>

<AlertCallouts alerts={ws.alerts} {onSetAlertStatus} />

{#snippet treeNode(node: TreeTopicVM | TreeNaniteVM)}
  {#if node.kind === 'topic'}
    {@const hasChildren = node.children.length > 0}
    {@const open = isExpanded(node.id)}
    <li class="tree-node">
      <div class="row-wrap">
        {#if hasChildren}
          <button
            class="twistie"
            aria-expanded={open}
            aria-label="{open ? 'Collapse' : 'Expand'} {node.label}"
            onclick={() => toggleExpand(node)}
          >
            <span aria-hidden="true" class="codicon codicon-chevron-{open ? 'down' : 'right'}"></span>
          </button>
        {:else}
          <span class="twistie-spacer"></span>
        {/if}
        <button
          class="tree-link"
          class:pinned={node.pinned}
          class:closed={node.status === 'closed'}
          onclick={() => onOpenTopic(node.slug)}
          oncontextmenu={(e) => openMenu(e, topicMenu(node))}
        >
          <span class="codicon codicon-{node.icon}"></span>
          <span class="tree-label">{node.label}</span>
          <span class="topic-slug mono">{node.slug}</span>
          {#if node.pinned}
            <span class="codicon codicon-pinned pin-badge" title="Pinned to this workstream"></span>
          {/if}
          {#if node.status !== 'open'}
            <span class="tree-meta">{node.status}</span>
          {/if}
          {#if node.alertCount > 0}
            <span
              class="alert-count"
              class:sev-alert={node.alertSeverity === 'alert'}
              title="{node.alertCount} open alert{node.alertCount === 1 ? '' : 's'}"
            >{node.alertCount}</span>
          {/if}
        </button>
      </div>
      {#if hasChildren && open}
        <ul class="tree-children">
          {#each sortTreeChildren(node.children) as child (child.id)}
            {@render treeNode(child)}
          {/each}
        </ul>
      {/if}
    </li>
  {:else}
    <li class="tree-node">
      <div class="row-wrap">
        <span class="twistie-spacer"></span>
        <button
          class="tree-link nanite"
          class:failed={node.phase === 'Failed'}
          onclick={() => onOpenNanite(node.openId)}
          oncontextmenu={(e) => openMenu(e, naniteMenu(node))}
        >
          {#if node.phase === 'Failed'}
            <span class="codicon codicon-error nanite-fail-icon" title="Failed"></span>
          {:else}
            <span class="codicon codicon-{node.icon}"></span>
          {/if}
          <span class="tree-label">{node.label}</span>
          <span class="tree-meta">{node.phase}</span>
        </button>
      </div>
    </li>
  {/if}
{/snippet}

{#if ws.tree.length > 0}
  <section class="tree" aria-label="Topics and nanites tree">
    {#each ws.tree as group (group.id)}
      {@const groupHasChildren = group.children.length > 0}
      {@const groupOpen = isExpanded(group.id)}
      <h2>
        {#if groupHasChildren}
          <button
            class="twistie"
            aria-expanded={groupOpen}
            aria-label="{groupOpen ? 'Collapse' : 'Expand'} {group.label}"
            onclick={() => toggleExpand(group)}
          >
            <span aria-hidden="true" class="codicon codicon-chevron-{groupOpen ? 'down' : 'right'}"></span>
          </button>
        {/if}
        <span class="codicon codicon-{group.icon}"></span>
        {group.label}
      </h2>
      {#if groupHasChildren}
        {#if groupOpen}
          <ul class="tree-list">
            {#each sortTreeChildren(group.children) as node (node.id)}
              {@render treeNode(node)}
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="empty">Empty.</p>
      {/if}
    {/each}
  </section>
{/if}

{#if menu}
  <div
    class="ctx-menu"
    role="menu"
    tabindex="-1"
    bind:this={menuEl}
    style="left: {menu.x}px; top: {menu.y}px;"
  >
    {#each menu.items as item}
      <button
        class="ctx-item"
        role="menuitem"
        disabled={item.disabled}
        onclick={() => runItem(item)}
      >
        {#if item.icon}
          <span class="codicon codicon-{item.icon}"></span>
        {:else}
          <span class="ctx-icon-spacer"></span>
        {/if}
        <span class="ctx-label">{item.label}</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .empty {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .title {
    margin: 0;
    font-size: 1.5em;
    font-weight: 600;
  }

  .title-input {
    flex: 1;
    font-size: 1.5em;
    font-weight: 600;
    padding: 4px 8px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 4px;
  }

  .title-input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .attrs {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 1px;
    background: var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    border-radius: 6px;
    overflow: hidden;
  }

  .attr {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 14px;
    background: var(--vscode-editor-background);
  }

  .attr.wide {
    grid-column: 1 / -1;
  }

  .attr .k {
    font-size: 0.75em;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }

  .attr .v {
    font-size: 0.95em;
    word-break: break-word;
  }

  .mono {
    font-family: var(--vscode-editor-font-family, monospace);
  }

  select {
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 4px;
    padding: 2px 6px;
  }

  .topic-slug {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }

  .tree h2 {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 1.05em;
    margin: 18px 0 8px;
  }

  .tree-list,
  .tree-children {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tree-children {
    margin-left: 16px;
    border-left: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
    padding-left: 6px;
  }

  .row-wrap {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .twistie {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 22px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--vscode-icon-foreground, var(--vscode-foreground));
    cursor: pointer;
    border-radius: 4px;
  }

  .twistie:hover {
    background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
  }

  .twistie:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }

  .twistie-spacer {
    flex: 0 0 auto;
    width: 20px;
  }

  .tree-link {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 1 1 auto;
    min-width: 0;
    text-align: left;
    padding: 4px 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 0.95em;
  }

  .tree-link:hover {
    background: var(--vscode-list-hoverBackground);
  }

  .tree-link.nanite {
    color: var(--vscode-descriptionForeground);
  }

  /* Closed topics recede: mute the row so completed work reads as done. Applies
     only to the row button, not the child <ul>, so nested state cues stay vivid.
     Pinned wins over closed (a pinned closed topic keeps its glow). */
  .tree-link.closed:not(.pinned) {
    color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
    opacity: 0.6;
  }

  .tree-link.closed:not(.pinned) .topic-slug {
    opacity: 0.85;
  }

  /* Failed nanite runs get a red X so failures pop in either theme. */
  .nanite-fail-icon {
    color: var(--vscode-errorForeground, var(--vscode-charts-red, #f14c4c));
  }

  .tree-link.nanite.failed .tree-meta {
    color: var(--vscode-errorForeground, var(--vscode-charts-red, #f14c4c));
    font-style: normal;
  }

  /* Pinned topics get a warm-yellow glow-up so focus reads at a glance. Uses
     color-mix over theme tokens so it stays legible in light + dark themes. */
  .tree-link.pinned {
    color: var(--vscode-charts-yellow, #d7ba7d);
    background: color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 12%, transparent);
    box-shadow: inset 0 0 0 1px
      color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 35%, transparent);
    text-shadow: 0 0 6px
      color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 45%, transparent);
    font-weight: 600;
  }

  .tree-link.pinned:hover {
    background: color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 20%, transparent);
  }

  .tree-link.pinned .topic-slug {
    color: color-mix(in srgb, var(--vscode-charts-yellow, #d7ba7d) 70%, var(--vscode-descriptionForeground));
  }

  .pin-badge {
    color: var(--vscode-charts-yellow, #d7ba7d);
    font-size: 0.85em;
  }

  .tree-label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tree-meta {
    margin-left: auto;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    font-style: italic;
  }

  /* Open-alert count bubble on a topic row. Neutral badge for informational,
     red for actionable ('alert'). margin-left:auto right-aligns it when there's
     no trailing status meta. */
  .alert-count {
    margin-left: auto;
    flex: none;
    min-width: 16px;
    height: 16px;
    padding: 0 5px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    font-size: 0.72em;
    font-weight: 600;
    line-height: 1;
    color: var(--vscode-badge-foreground, #fff);
    background: var(--vscode-badge-background, #4d4d4d);
  }

  .alert-count.sev-alert {
    color: #fff;
    background: var(--vscode-editorError-foreground, #f14c4c);
  }

  /* Custom right-click context menu — webviews get no native tree menu. */
  .ctx-menu {
    position: fixed;
    z-index: 50;
    min-width: 180px;
    padding: 4px;
    display: flex;
    flex-direction: column;
    gap: 1px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
    border-radius: 6px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }

  .ctx-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    padding: 5px 10px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
    font-size: 0.9em;
  }

  .ctx-item:hover:not(:disabled) {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
  }

  .ctx-item:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .ctx-icon-spacer {
    width: 16px;
  }
</style>
