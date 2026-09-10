import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('desktop tree icon contract', () => {
  it('loads codicons and gives expandable controls stable dimensions and labels', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');
    const workstreamView = readFileSync(resolve(repoRoot, 'webview-ui/src/lib/WorkstreamView.svelte'), 'utf8');

    expect(styles).toContain("@import '../../../media/codicons/codicon.css'");
    expect(styles).toMatch(/\.active-twistie[^}]*width:\s*26px[^}]*height:\s*26px/s);
    expect(activeRail).toContain('data-expandable="true"');
    expect(activeRail).toContain("aria-label=\"{open ? 'Collapse' : 'Expand'} {node.label}\"");
    expect(activeRail).not.toContain("codicon-{open ? 'remove' : 'add'}");
    expect(activeRail).toContain("codicon-chevron-{open ? 'down' : 'right'}");
    expect(workstreamView).toContain("aria-label=\"{open ? 'Collapse' : 'Expand'} {node.label}\"");
    expect(workstreamView).toContain('codicon-chevron-');
  });

  it('uses one readable cross-platform UI font stack without overriding codicons', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');

    expect(styles).toContain('"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, Cantarell, "Noto Sans", sans-serif');
    expect(styles).not.toMatch(/Georgia|,\s*serif(?:[;,)])/);
    expect(styles).toContain("@import '../../../media/codicons/codicon.css'");
  });

  it('uses compact single-color graph nesting and exposes accessible rail collapse controls', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');

    expect(styles).toMatch(/\.active-card-body[^}]*--active-tree-control-width:\s*22px/s);
    expect(styles).toMatch(/\.active-tree-node[^}]*padding-left:\s*0/s);
    expect(styles).toMatch(/\.topic-tree[^}]*--graph-color:\s*var\(--ws-card-border\)/s);
    expect(styles).toMatch(/\.graph-node-dot[^}]*border:\s*2px solid var\(--graph-color\)[^}]*border-radius:\s*50%/s);
    expect(styles).toMatch(/\.graph-node-passive \.graph-node-dot[^}]*background:\s*var\(--graph-color\)/s);
    expect(styles).toMatch(/\.graph-node-control\[aria-expanded="true"\] \.graph-node-dot\s*{[^}]*background:\s*var\(--graph-color\)[^}]*}/s);
    expect(styles).not.toMatch(/\.graph-node-control\[aria-expanded="true"\] \.graph-node-dot\s*{[^}]*box-shadow:/s);
    expect(styles).toMatch(/\.branch-tree[^}]*margin-left:\s*17px/s);
    expect(styles).toMatch(/\.tree-connector path[^}]*stroke:\s*var\(--graph-color\)[^}]*stroke-width:\s*2px[^}]*stroke-linecap:\s*round/s);
    expect(styles).not.toContain('.branch-tree::before');
    expect(styles).not.toContain('.branch-tree::after');
    expect(styles).not.toMatch(/\.active-tree-node::(?:before|after)/);
    expect(activeRail).toContain('class="topic-tree" use:attachTreeConnector');
    expect(styles).not.toContain('.topic-tree::before');
    expect(styles).toMatch(/\.active-tree-node > \.active-row > \.graph-node-control[^}]*width:\s*var\(--active-tree-control-width\)/s);
    expect(styles).toMatch(/\.active-card-header, \.active-row[^}]*min-height:\s*32px/s);
    expect(styles).toMatch(/\.shell\.active-collapsed[^}]*grid-template-columns:\s*36px/s);
    expect(styles).toMatch(/\.shell\.chat-collapsed[^}]*36px/s);
    expect(app).toContain("aria-label={activeRailCollapsed ? 'Expand Active rail' : 'Collapse Active rail'}");
    expect(app).toContain("aria-label={chatRailCollapsed ? 'Expand Chat rail' : 'Collapse Chat rail'}");
    expect(app).toContain('class:active-collapsed={activeRailCollapsed}');
    expect(app).toContain('class:chat-collapsed={chatRailCollapsed}');
  });

  it('keeps Active row actions in a context menu and renders focused topics as a pinned strip', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');

    expect(activeRail).toContain('oncontextmenu=');
    expect(activeRail).toContain('class="active-row"');
    expect(activeRail).toContain('role="group"');
    expect(activeRail).toContain('role="menu"');
    expect(activeRail).toContain('tabindex="-1"');
    expect(activeRail).toContain('role="menuitem"');
    expect(activeRail).toContain("menuElement.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()");
    expect(activeRail).toContain("event.key === 'Escape'");
    expect(activeRail).not.toContain('class="active-actions"');
    expect(activeRail).not.toContain('class="active-icon-button focus-button"');
    expect(activeRail).toContain('class="codicon codicon-{topic.icon}"');
    expect(activeRail).toContain('<section class="pinned-topics"');
    expect(activeRail).toContain('aria-label={`Pinned topics in ${workstream.label}`}');
    expect(activeRail).toContain('class="focused-topic-open"');
    expect(activeRail).toContain('onclick={() => onOpen(topic.openUri)}');
    expect(activeRail).toContain('class="focused-topic-pin"');
    expect(activeRail).toContain('event.stopPropagation();');
    expect(activeRail).toContain("onToggleFocus(workstream.slug ?? '', topicSlug);");
    expect(activeRail).toContain('class="codicon codicon-pinned"');
    expect(activeRail.indexOf('class="focused-topic-pin"')).toBeLessThan(activeRail.indexOf('class="focused-topic-open"'));
    expect(styles).toMatch(/\.active-context-menu[^}]*position:\s*fixed/s);
    expect(styles).toMatch(/\.pinned-topics[^}]*border-bottom:\s*1px/s);
    expect(styles).toMatch(/\.focused-topic-pin[^}]*width:\s*30px[^}]*height:\s*30px/s);
    expect(styles).not.toContain('.focused-topic::before');
    expect(styles).toMatch(/\.tree-connector[^}]*pointer-events:\s*none/s);
  });

  it('renders queue and backlog as summaries while progress alone owns disclosure and graph details', () => {
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');

    expect(activeRail).toContain("workstreamCard(workstream: PanelWorkstream, sectionStatus: PanelWorkstreamSection['section'], compact: boolean)");
    expect(activeRail).toContain("const expandable = sectionStatus === 'progress' && hasDetails");
    expect(activeRail).toContain('setNodeAndChildrenExpanded(expanded, workstream)');
    expect(activeRail).toContain('onclick={() => toggleWorkstream(workstream)}');
    expect(activeRail).toContain("class:summary={sectionStatus !== 'progress'}");
    expect(activeRail).toContain('data-section-status={sectionStatus}');
    expect(activeRail).toContain("{:else if sectionStatus === 'progress'}");
    expect(activeRail).toContain('{#if expandable && open}');
    expect(activeRail).toContain('workstreamCard(workstream, section.section, section.display');
    expect(activeRail).toContain('class="graph-node-control"');
    expect(activeRail).toContain('class="graph-node-dot"');
    expect(activeRail).toContain('class="graph-node-control graph-node-passive"');
    expect(activeRail).not.toMatch(/codicon-(?:add|remove)/);
    expect(styles).toMatch(/\.active-card\.summary[^}]*box-shadow:\s*none/s);
    expect(styles).toContain('--graph-color: var(--ws-card-border)');
  });

  it('renders workstream reorder drop targets and insertion feedback', () => {
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');

    expect(activeRail).toContain('startWorkstreamDrag');
    expect(activeRail).toContain('ondragenter=');
    expect(activeRail).toContain('ondragover=');
    expect(activeRail).toContain('ondrop=');
    expect(activeRail).toContain('class:drop-target=');
    expect(activeRail).toContain('class="active-drop-indicator"');
    expect(activeRail).toContain('await onReorder(slug, section, index)');
    expect(activeRail).toContain(
      'class="active-open workstream-open"\n        title={workstream.tooltip}\n        draggable="true"',
    );
    expect(activeRail).not.toContain('workstream-drag-handle');
    expect(activeRail).not.toContain(
      'class="active-card-header"\n      role="group"\n      draggable="true"',
    );
    expect(activeRail).toContain("let activeDrag = $state<");
    expect(activeRail).toContain("activeDrag?.kind === 'topic'");
    expect(activeRail).toContain("activeDrag?.kind === 'workstream'");
    expect(styles).toMatch(/\.active-card-header[^}]*cursor:\s*grab/);
    expect(app).toContain('planWorkstreamReorder(order, slug, targetSection, targetIndex)');
    expect(app).toContain('window.workingMemory.reorderWorkstreams(updates)');
    expect(styles).toMatch(/\.active-section\.drop-target[^}]*var\(--desktop-accent\)/s);
    expect(styles).toMatch(/\.active-drop-indicator[^}]*height:\s*0/s);
    expect(styles).toMatch(/\.active-drop-indicator::after[^}]*height:\s*3px/s);
  });

  it('subdues closed topics without rendering topic status text or muting alerts', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');

    expect(activeRail).toContain("class:closed={node.kind === 'topic' && node.status === 'closed'}");
    expect(activeRail).not.toContain('{node.status}');
    expect(activeRail).toContain('<span class="active-description">{node.phase}</span>');
    expect(styles).toMatch(/\.active-row\.closed \.active-open\s*{[^}]*color:\s*var\(--desktop-active-muted\)/s);
    expect(styles).not.toMatch(/\.active-row\.closed\s*{[^}]*opacity:/s);
  });

  it('uses border-integrated six-pixel rail resize targets', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');

    expect(styles).toMatch(/\.shell[^}]*grid-template-columns:\s*var\(--active-rail-width\) 0 minmax\(320px, 1fr\) 0 var\(--chat-rail-width\)/s);
    expect(styles).toMatch(/\.rail-splitter[^}]*width:\s*6px[^}]*background:\s*transparent/s);
    expect(styles).toMatch(/\.rail-splitter::after[^}]*width:\s*1px[^}]*background:\s*var\(--desktop-active-border\)/s);
    expect(styles).not.toMatch(/\.rail-splitter[^}]*background:\s*#303030/s);
  });

  it('uses pink Active section bars as accessible vertical resize handles', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');

    expect(styles).toMatch(/\.active-section-header[^}]*background:\s*var\(--desktop-accent\)/s);
    expect(styles).toMatch(/\.active-section-header\.resizable[^}]*cursor:\s*row-resize[^}]*touch-action:\s*none/s);
    expect(activeRail).toContain("role={section.section !== 'queue' ? 'separator' : undefined}");
    expect(activeRail).toContain("aria-orientation={section.section !== 'queue' ? 'horizontal' : undefined}");
    expect(activeRail).toContain('onpointerdown=');
    expect(activeRail).toContain('resizeSectionWithKeyboard');
  });

  it('keeps selected-document context and composer in a stable center-stage row', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');

    expect(app).toContain('const currentChatContext = $derived(chatContextForDocument(activeDocument));');
    expect(app).toContain('class="composer-context"');
    expect(app).toContain('{currentChatContext.kind}');
    expect(app).toContain('{currentChatContext.title}');
    expect(styles).toMatch(/\.main[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto auto/s);
    expect(styles).toMatch(/\.stage-content[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.chat-rail[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)/s);
    expect(styles).toMatch(/\.conversation[^}]*overflow-y:\s*auto/s);
    expect(styles).toMatch(/\.composer-context[^}]*text-overflow:\s*ellipsis/s);
    expect(styles).toMatch(/\.composer-shell[^}]*background:\s*#eceaec/s);
    expect(app.indexOf('<main class="main">')).toBeLessThan(app.indexOf('<div class="composer-shell">'));
    expect(app.indexOf('<div class="composer-shell">')).toBeLessThan(app.indexOf('<aside class="chat-rail">'));
  });

  it('renders stable selectable document tabs without duplicate-open stack navigation', () => {
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');

    expect(app).toContain('class="document-tabs" role="tablist"');
    expect(app).toContain('role="tab"');
    expect(app).toContain('aria-selected={key === selectedDocumentKey}');
    expect(app).toContain('onclick={() => closeDocument(key)}');
    expect(app).toContain('openDocumentTab({ tabs: documents, selectedKey: selectedDocumentKey }, document)');
    expect(app).toContain('oncontextmenu={(event) => void openDocumentTabMenu(event, key)}');
    expect(app).toContain('<span>Close Others</span>');
    expect(app).toContain('<span>Close to the Right</span>');
    expect(app).toContain("closeOtherDocumentTabs(state, key)");
    expect(app).toContain("closeDocumentTabsToRight(state, key)");
    expect(styles).toMatch(/\.document-tabs[^}]*height:\s*38px[^}]*overflow-x:\s*auto/s);
    expect(styles).toMatch(/\.document-tab-menu[^}]*position:\s*fixed[^}]*z-index:\s*30/s);
  });

  it('shows at most two current-scope messages and targets stable history elements', () => {
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const previewIndex = app.indexOf('<section class="scope-preview"');
    const composerIndex = app.indexOf('<div class="composer-shell">');
    const chatRailIndex = app.indexOf('<aside class="chat-rail">');

    expect(app).toContain('recentRunsForContext(chatRuns, currentChatContext)');
    expect(app).toContain('aria-label="Recent messages"');
    expect(app).toContain('<span>Recent messages</span>');
    expect(app).not.toContain('Selected file:');
    expect(app).not.toContain('Current scope');
    expect(previewIndex).toBeGreaterThan(app.indexOf('<main class="main">'));
    expect(previewIndex).toBeLessThan(composerIndex);
    expect(composerIndex).toBeLessThan(chatRailIndex);
    expect(app.slice(chatRailIndex)).not.toContain('class="scope-preview"');
    expect(app).toContain('No messages for this scope.');
    expect(app).toContain('chatRailCollapsed = false;');
    expect(app).toContain('const target = document.getElementById(chatRunDomId(run));');
    expect(app).toContain("scroller.addEventListener('scrollend', finish, { once: true });");
    expect(app).toContain('idleTimer = window.setTimeout(finish, 120);');
    expect(app).toContain('const needsScroll = scrollerBounds');
    expect(app).toContain('scroller && needsScroll ? waitForScrollEnd(scroller) : Promise.resolve()');
    expect(app).toContain("target.scrollIntoView({ behavior: 'smooth', block: 'center' });");
    expect(app).toContain('await scrollFinished;');
    expect(app).toContain('target.focus({ preventScroll: true });');
    expect(app).toContain("target.classList.remove('preview-attention');");
    expect(app).toContain('void target.offsetWidth;');
    expect(app).toContain("target.classList.add('preview-attention');");
    expect(app).toContain("target.addEventListener('animationend', finish, { once: true });");
    expect(app).toContain("target?.classList.remove('preview-attention');");
    expect(app).toContain('id={chatRunDomId(run)}');
    expect(app).toContain('tabindex="-1"');
    expect(styles).toMatch(/\.chat-run\.preview-attention::after[^}]*z-index:\s*2[^}]*border:\s*2px solid var\(--desktop-accent-strong\)[^}]*animation:\s*chat-run-attention \.55s ease-in-out 2/s);
    expect(styles).toContain('@keyframes chat-run-attention');
    expect(styles).toMatch(/@keyframes chat-run-attention[^]*50%[^}]*opacity:\s*1/s);
    expect(styles).toMatch(/@media \(prefers-reduced-motion: reduce\)[^{]*{[^}]*\.chat-run\.preview-attention::after[^}]*animation:\s*none/s);
  });

  it('persists an environment-scoped unsent composer draft and uses instructional placeholder text', () => {
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');

    expect(app).not.toContain('Show me the 0.15.0 roadmap workstream');
    expect(app).toContain('placeholder="Write a command to interact with Working Memory"');
    expect(app).toContain('oninput={(event) => updateComposerDraft(event.currentTarget.value)}');
    expect(app).toContain('readComposerDraft(localStorage, selectedEnvironment?.id)');
    expect(app).toContain("writeComposerDraft(localStorage, selectedEnvironment?.id, '')");
  });

  it('keeps the chat pinned only while the reader remains at the bottom', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');

    expect(app).toContain('bind:this={conversationElement}');
    expect(app).toContain('onscroll={handleConversationScroll}');
    expect(app).toContain('if (shouldStick) scrollConversationToBottom()');
    expect(app).toContain('class="new-message-indicator"');
    expect(app).toContain('aria-label="Jump to newest message"');
    expect(styles).toMatch(/\.conversation-shell[^}]*position:\s*relative/s);
    expect(styles).toMatch(/\.new-message-indicator[^}]*position:\s*absolute/s);
  });

  it('shows the selected port instead of Active and rediscovers before environment selection', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');

    expect(activeRail).not.toContain('<strong>Active</strong>');
    expect(activeRail).toContain("{selectedEnvironment?.displayName ?? 'No server'}");
    expect(activeRail).toContain('class="environment-trigger"');
    expect(activeRail).toContain('await onDiscoverEnvironments()');
    expect(activeRail).toContain('role="menuitemradio"');
    expect(app).toContain('window.workingMemory.switchEnvironment(mcpUrl)');
    expect(app).toContain('reloadEnvironmentBoundData(refreshActive, () => loadHistory())');
    expect(styles).toMatch(/\.environment-trigger[^}]*grid-template-columns:\s*16px minmax\(0, 1fr\) 14px/s);
  });
});