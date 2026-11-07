<script lang="ts">
  import type { TopicLinkDragController, TopicLinkReference } from '../resourceDrag';
  import { FALLBACK_TOPIC_ICON } from './viewRegistry';

  let { topic, drag, onOpen, onAddChild, onAddToWorkstream, icon = FALLBACK_TOPIC_ICON }: {
    topic: TopicLinkReference;
    drag: TopicLinkDragController;
    onOpen: (id: string) => void;
    onAddChild?: (topic: TopicLinkReference) => void;
    onAddToWorkstream?: (topic: TopicLinkReference) => void;
    icon?: string;
  } = $props();
  let menu = $state<{ x: number; y: number } | null>(null);
  let menuEl = $state<HTMLDivElement | undefined>();
  $effect(() => { drag.prepare(topic.id, topic.title); });
  $effect(() => {
    if (!menu) return;
    function dismiss(event: MouseEvent): void {
      if (event.target instanceof Node && menuEl?.contains(event.target)) return;
      menu = null;
    }
    function escape(event: KeyboardEvent): void { if (event.key === 'Escape') menu = null; }
    window.addEventListener('click', dismiss);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('keydown', escape);
    };
  });
  function openMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    menu = { x: Math.max(4, Math.min(event.clientX, window.innerWidth - 224)),
      y: Math.max(4, Math.min(event.clientY, window.innerHeight - 72)) };
  }
</script>

<button class="topic-link" title={topic.title} draggable="true"
  onpointerdown={() => drag.prepare(topic.id, topic.title)}
  ondragstart={event => drag.start(event, topic.id, topic.title)}
  ondragend={() => drag.finish()}
  oncontextmenu={openMenu} onclick={() => onOpen(topic.id)}>
  <span aria-hidden="true" class="codicon codicon-{icon}"></span>
  <span class="topic-title">{topic.title}</span>
</button>
{#if menu}
  <div class="topic-link-menu" role="menu" aria-label="Topic actions" tabindex="-1"
    bind:this={menuEl} style="left: {menu.x}px; top: {menu.y}px;">
    <button role="menuitem" disabled={!onAddChild}
      onclick={() => { menu = null; onAddChild?.(topic); }}>
      <span aria-hidden="true" class="codicon codicon-add"></span>Add Child...
    </button>
    <button role="menuitem" disabled={!onAddToWorkstream}
      onclick={() => { menu = null; onAddToWorkstream?.(topic); }}>
      <span aria-hidden="true" class="codicon codicon-add"></span>Add to workstream
    </button>
  </div>
{/if}

<style>
  .topic-link {
    display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0;
    text-align: left; padding: 4px 8px; border: none; border-radius: 4px;
    background: transparent; color: var(--vscode-foreground); cursor: pointer; font-size: 0.95em;
  }
  .topic-link:hover { background: var(--vscode-list-hoverBackground); }
  .topic-link:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .topic-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .topic-link-menu {
    position: fixed; z-index: 50; min-width: 180px; padding: 4px;
    display: flex; flex-direction: column; gap: 1px;
    background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
    color: var(--vscode-menu-foreground, var(--vscode-foreground));
    border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
    border-radius: 6px; box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
  }
  .topic-link-menu button {
    display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    padding: 5px 10px; border: none; border-radius: 4px; background: transparent;
    color: inherit; cursor: pointer; font-size: 0.9em;
  }
  .topic-link-menu button:hover:not(:disabled) {
    background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
    color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
  }
  .topic-link-menu button:disabled { opacity: 0.5; cursor: default; }
</style>
