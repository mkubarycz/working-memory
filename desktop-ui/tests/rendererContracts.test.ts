import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(import.meta.dirname, '../..');

describe('desktop tree icon contract', () => {
  it('uses Refresh as the explicit desktop restart boundary', () => {
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');
    const preload = readFileSync(resolve(repoRoot, 'desktop-ui/src/preload/index.ts'), 'utf8');
    const main = readFileSync(resolve(repoRoot, 'desktop-ui/src/main/index.ts'), 'utf8');

    expect(app).toContain('onRefresh={() => window.workingMemory.restartDesktop()}');
    expect(activeRail).toContain('title="Restart to apply latest build"');
    expect(activeRail).toContain('aria-label="Restart Working Memory"');
    expect(preload).toContain("restartDesktop: () => ipcRenderer.send('app:restart')");
    expect(main).toContain("ipcMain.on('app:restart'");
    expect(main).toContain('app.relaunch({ execPath: STABLE_DESKTOP_EXECUTABLE, args: [] })');
  });

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
    expect(activeRail).toContain("':scope > .active-context-menu-entry > button:not(:disabled)'");
    expect(activeRail).toContain("event.key === 'Escape'");
    expect(activeRail).toContain('aria-label="Move topic tree to workstream"');
    expect(activeRail).toContain('moveTopicFromMenu(event, item, target.slug)');
    expect(activeRail).toContain('sourceWorkstream: workstream');
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
    expect(styles).toMatch(/\.active-context-submenu[^}]*position:\s*absolute/s);
    expect(styles).toContain('.active-context-menu-entry:hover > .active-context-submenu');
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
    const preload = readFileSync(resolve(repoRoot, 'desktop-ui/src/preload/index.ts'), 'utf8');
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');

    expect(activeRail).toContain('startWorkstreamDrag');
    expect(activeRail).toContain('ondragenter=');
    expect(activeRail).toContain('ondragover=');
    expect(activeRail).toContain('ondrop=');
    expect(activeRail).toContain('class:drop-target=');
    expect(activeRail).toContain('class="active-drop-indicator"');
    expect(activeRail).toContain('await onReorder(slug, section, index)');
    expect(activeRail).not.toContain('active-drag-handle');
    expect(activeRail).not.toContain(
      'class="active-card-header"\n      role="group"\n      draggable="true"',
    );
    expect(activeRail).toContain("let activeDrag = $state<");
    expect(activeRail).toContain("activeDrag?.kind === 'topic'");
    expect(activeRail).toContain("activeDrag?.kind === 'workstream'");
    expect(activeRail).toContain('event.preventDefault();');
    expect(activeRail).toContain('window.workingMemory.startResourceDrag(prepared)');
    expect(activeRail).toContain('onResourceDragResult');
    expect(activeRail).toContain("result.status === 'failed'");
    expect(activeRail).not.toContain("result.status === 'started'");
    expect(activeRail).toContain('dragPreparationGeneration += 1');
    expect(activeRail).toContain('generation === dragPreparationGeneration');
    expect(activeRail).toContain('ondragleave={clearExternalDragVisual}');
    expect(activeRail).toContain('onpointermove={clearCompletedNativeDrag}');
    expect(activeRail).toContain('class:dragging={draggingWorkstreamSlug === workstream.slug}');
    expect(preload).toContain("ipcRenderer.send('resource:start-drag'");
    expect(preload).toContain("ipcRenderer.on('resource:drag-result'");
    expect(app).toContain('planWorkstreamReorder(order, slug, targetSection, targetIndex)');
    expect(app).toContain('window.workingMemory.reorderWorkstreams(updates)');
    expect(styles).toMatch(/\.active-section\.drop-target[^}]*var\(--desktop-accent\)/s);
    expect(styles).toMatch(/\.active-drop-indicator[^}]*height:\s*0/s);
    expect(styles).toMatch(/\.active-drop-indicator::after[^}]*height:\s*3px/s);
  });

  it('shows the immutable desktop build timestamp in a global status bar', () => {
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const viteConfig = readFileSync(resolve(repoRoot, 'desktop-ui/electron.vite.config.ts'), 'utf8');

    expect(viteConfig).toContain('__WM_BUILD_TIMESTAMP__');
    expect(viteConfig).toContain('new Date().toISOString()');
    expect(activeRail).not.toContain('desktopBuildLabel');
    expect(activeRail).not.toContain('DESKTOP_BUILD_TIMESTAMP');
    expect(app).toContain('class="desktop-status-bar"');
    expect(app).toContain('Built {desktopBuildLabel}');
    expect(app).toContain('title={`Built ${DESKTOP_BUILD_TIMESTAMP}`}');
    expect(styles).toMatch(/\.desktop-status-bar\s*{[^}]*grid-column:\s*1\s*\/\s*-1/s);
  });

  it('subdues closed topics without rendering topic status text or muting alerts', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const activeRail = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/ActiveRail.svelte'), 'utf8');

    expect(activeRail).toContain("class:closed={node.status === 'closed'}");
    expect(activeRail).not.toContain('{node.status}');
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
    const documentHost = app.slice(app.indexOf('<div class="document-stage">'), app.indexOf('<section class="empty-state">'));
    expect(documentHost).toContain('ContainerAppDetail');
    expect(documentHost).toContain("activeDocument?.kind === 'container-app'");
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
    const focus = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/chatRunFocus.ts'), 'utf8');
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
    expect(app).toContain("activateLog: () => activateHeaderTab('log')");
    expect(app).toContain('expandChatRail: () => (chatRailCollapsed = false)');
    expect(app).toContain('getTarget: () => document.getElementById(chatRunDomId(run))');
    expect(focus.indexOf('dependencies.activateLog();')).toBeLessThan(focus.indexOf('await dependencies.afterRender();'));
    expect(focus).toContain('const target = dependencies.getTarget();');
    expect(app).toContain("scroller.addEventListener('scrollend', finish, { once: true });");
    expect(app).toContain('idleTimer = window.setTimeout(finish, 120);');
    expect(focus).toContain('const needsScroll = scrollerBounds');
    expect(focus).toContain('dependencies.waitForScrollEnd(scroller)');
    expect(focus).toContain("target.scrollIntoView({ behavior: 'smooth', block: 'center' });");
    expect(focus).toContain('await scrollFinished;');
    expect(focus).toContain('target.focus({ preventScroll: true });');
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
    expect(app).toContain('oninput={handleComposerInput}');
    expect(app).toContain('readComposerDraft(localStorage, selectedEnvironment?.id)');
    expect(app).toContain("writeComposerDraft(localStorage, selectedEnvironment?.id, '')");
  });

  it('exposes an accessible, mouse-selectable Container App mention list without stealing composer focus', () => {
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');

    expect(app).toContain('role="combobox"');
    expect(app).toContain('aria-autocomplete="list"');
    expect(app).toContain('aria-activedescendant=');
    expect(app).toContain('aria-describedby="mention-instructions"');
    expect(app).toContain('role="listbox"');
    expect(app).toContain('role="option"');
    expect(app).toContain('No Container Apps match');
    expect(app).toContain("'MCP ready' : 'No MCP endpoint'");
    expect(app).toContain('onmousedown={(event) => event.preventDefault()}');
    expect(app).toContain('onclick={() => void selectMention(app)}');
    expect(app).toContain('composerTextarea?.setSelectionRange(replacement.caret, replacement.caret)');
    expect(app).toContain('mentionKeyEventAction(event, mentionOpen, mentionApps.length, mentionActiveIndex)');
    expect(app).toMatch(/async function send\(\)[^]*closeMentionCompletion\(\);[^]*await submitChat\(message, context\);/);
    expect(app).toContain("page = 'workspace';\n    closeMentionCompletion();");
    expect(styles).toMatch(/\.mention-popup[^}]*position:\s*absolute/);
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
    expect(app).toContain('reloadEnvironmentBoundData(refreshActive, () => refreshLatestHistory(true))');
    expect(styles).toMatch(/\.environment-trigger[^}]*grid-template-columns:\s*16px minmax\(0, 1fr\) 14px/s);
  });
});