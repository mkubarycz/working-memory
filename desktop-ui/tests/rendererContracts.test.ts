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
    expect(workstreamView).toContain("aria-label=\"{open ? 'Collapse' : 'Expand'} {node.label}\"");
    expect(workstreamView).toContain('codicon-chevron-');
  });

  it('uses one readable cross-platform UI font stack without overriding codicons', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');

    expect(styles).toContain('"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", Ubuntu, Cantarell, "Noto Sans", sans-serif');
    expect(styles).not.toMatch(/Georgia|,\s*serif(?:[;,)])/);
    expect(styles).toContain("@import '../../../media/codicons/codicon.css'");
  });

  it('uses compact connector-led tree nesting and exposes accessible rail collapse controls', () => {
    const styles = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/style.css'), 'utf8');
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');

    expect(styles).toMatch(/\.active-tree-node[^}]*padding-left:\s*4px/s);
    expect(styles).toMatch(/\.active-tree \.active-tree[^}]*border-left:\s*1px solid #454545/s);
    expect(styles).toMatch(/\.active-tree-node::before[^}]*width:\s*8px[^}]*height:\s*1px/s);
    expect(styles).toMatch(/\.active-card-header, \.active-row[^}]*min-height:\s*32px/s);
    expect(styles).toMatch(/\.shell\.active-collapsed[^}]*grid-template-columns:\s*36px/s);
    expect(styles).toMatch(/\.shell\.chat-collapsed[^}]*36px/s);
    expect(app).toContain("aria-label={activeRailCollapsed ? 'Expand Active rail' : 'Collapse Active rail'}");
    expect(app).toContain("aria-label={chatRailCollapsed ? 'Expand Chat rail' : 'Collapse Chat rail'}");
    expect(app).toContain('class:active-collapsed={activeRailCollapsed}');
    expect(app).toContain('class:chat-collapsed={chatRailCollapsed}');
  });

  it('keeps Active row actions in a context menu and gives focused topics a separate pin control', () => {
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
    expect(activeRail).toContain('class="focused-topic-open"');
    expect(activeRail).toContain('onclick={() => onOpen(topic.openUri)}');
    expect(activeRail).toContain('class="focused-topic-pin"');
    expect(activeRail).toContain('event.stopPropagation();');
    expect(activeRail).toContain("onToggleFocus(workstream.slug ?? '', topicSlug);");
    expect(activeRail).toContain('class="codicon codicon-pinned"');
    expect(activeRail).not.toMatch(/focused-topic-pin[\s\S]*?onOpen\(/);
    expect(styles).toMatch(/\.active-context-menu[^}]*position:\s*fixed/s);
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
    expect(styles).toMatch(/\.main[^}]*grid-template-rows:\s*minmax\(0, 1fr\) auto/s);
    expect(styles).toMatch(/\.stage-content[^}]*overflow:\s*auto/s);
    expect(styles).toMatch(/\.chat-rail[^}]*grid-template-rows:\s*auto auto minmax\(0, 1fr\)/s);
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
    expect(styles).toMatch(/\.document-tabs[^}]*height:\s*38px[^}]*overflow-x:\s*auto/s);
  });

  it('shows at most two current-scope messages and targets stable history elements', () => {
    const app = readFileSync(resolve(repoRoot, 'desktop-ui/src/renderer/App.svelte'), 'utf8');

    expect(app).toContain('recentRunsForContext(chatRuns, currentChatContext)');
    expect(app).toContain('class="scope-preview"');
    expect(app).toContain('No messages for this scope.');
    expect(app).toContain('document.getElementById(chatRunDomId(run))?.scrollIntoView');
    expect(app).toContain('id={chatRunDomId(run)}');
    expect(app).toContain('tabindex="-1"');
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