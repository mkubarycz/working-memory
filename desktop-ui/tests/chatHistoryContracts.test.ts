import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = resolve(import.meta.dirname, '..');
const entry = readFileSync(resolve(desktopRoot, 'src/renderer/MessageEntry.svelte'), 'utf8');
const timeline = readFileSync(resolve(desktopRoot, 'src/renderer/MessageTimeline.svelte'), 'utf8');

describe('desktop chat history IPC contract', () => {
  it('exposes typed history pages and full journal detail through preload IPC', () => {
    const contracts = readFileSync(resolve(desktopRoot, 'src/shared/contracts.ts'), 'utf8');
    const preload = readFileSync(resolve(desktopRoot, 'src/preload/index.ts'), 'utf8');
    const main = readFileSync(resolve(desktopRoot, 'src/main/index.ts'), 'utf8');

    expect(contracts).toContain('getChatHistory(input?: CommandJournalHistoryInput): Promise<CommandJournalHistoryPage>');
    expect(contracts).toContain('getChatJournal(id: string): Promise<CommandJournal | null>');
    expect(preload).toContain("getChatHistory: (input = {}) => invoke('chat:history', input)");
    expect(preload).toContain("getChatJournal: (id) => invoke('chat:journal', id)");
    expect(main).toContain("ipcMain.handle('chat:history'");
    expect(main).toContain('controlPlane().commandJournalRead(input)');
    expect(main).toContain("ipcMain.handle('chat:journal'");
    expect(main).toContain('controlPlane().commandJournalRead({ id })');
  });

  it('carries the stable journal id through start, confirmation, and renderer results', () => {
    const agent = readFileSync(resolve(desktopRoot, 'src/main/desktopChatAgent.ts'), 'utf8');
    const main = readFileSync(resolve(desktopRoot, 'src/main/index.ts'), 'utf8');

    expect(agent).toContain('journalId: session.journal.id');
    expect(agent).toContain("status: 'awaiting_confirmation'");
    expect(agent).toContain('status,');
    expect(main).toContain('journalId: result.journalId');
    expect(main).toContain('status: result.status');
    expect(main.match(/status: 'failed'/g)?.length).toBeGreaterThanOrEqual(4);
  });

  it('refreshes changed journals without polling or clobbering the older-page cursor', () => {
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');

    expect(app).toContain('await Promise.all([refreshActive(), refreshLatestHistory(true), refreshAgentMessages(), refreshBackendHealth(), loadContainerApps(), refreshFeatures()]);');
    expect(app).toContain('window.workingMemory.onDocumentChanges(handleDocumentChanges)');
    expect(app).toContain('stopListeningForChanges();');
    expect(app).not.toContain('setInterval(() => void refreshLatestHistory()');
    expect(app).toContain('if (historyRequestGeneration === generation) return;');
    expect(app).toContain('setChatRuns(refreshLatestRuns(chatRuns, historyPage.journals)');
    expect(app).toContain('if (initialize) historyCursor = historyPage.nextCursor;');
    expect(app).toContain('setChatRuns(mergeHistoryRuns(chatRuns, historyPage.journals), false)');
    expect(app).toContain('historyCursor = historyPage.nextCursor;');
    expect(app).toContain('cursor: historyCursor');
    expect(app).toContain('onclick={() => void loadOlderHistory()}');
    expect(app).toContain('conversationElement.scrollTop = previousTop + conversationElement.scrollHeight - previousHeight;');
    expect(app).toContain('Loading history…');
    expect(app).toContain('No message history.');
  });

  it('renders a collapsible scoped conversation above the composer with independent Retry actions', () => {
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');
    const recent = readFileSync(resolve(desktopRoot, 'src/renderer/RecentMessages.svelte'), 'utf8');
    const styles = readFileSync(resolve(desktopRoot, 'src/renderer/style.css'), 'utf8');

    expect(app).toContain('run.attachments.map((attachment) => ({');
    expect(app).toContain('onRetry={(run) => void retryRun(run)}');
    expect(entry).toContain('onclick={() => onRetry(run)}');
    expect(app).toContain('bind:expanded={scopePreviewExpanded}');
    expect(recent).toContain('class:expanded');
    expect(recent).toContain('Expand for all messages and details');
    expect(recent).toContain('<MessageTimeline');
    expect(entry).toContain('class="user-entry"');
    expect(entry).toContain('<ToolActivity');
    expect(entry).toContain('class="assistant-entry"');
    expect(app).toContain('scopePreviewExpanded = true;');
    expect(entry).toContain('class="run-actions"');
    expect(entry).toContain('disabled={runBlocked(run)}');
    expect(entry).toContain('One approval covers this bounded batch.');
    expect(entry).toContain('pendingConfirmation.batchCount');
    expect(entry).toContain('class="timeline-command"');
    expect(entry).toContain('class="timeline-details"');
    expect(entry).toContain('use:observeResponse=');
    expect(styles).toMatch(/\.retry-button\s*{[^}]*font-size:\s*10px/s);
    expect(styles).toMatch(/\.scope-preview-history\s*{[^}]*max-height:\s*min\(42vh,\s*420px\)[^}]*overflow-y:\s*auto/s);
    expect(styles).toMatch(/\.message-preview\s*{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
    expect(entry).toContain('bind:open={expanded}');
  });

  it('scrolls attention messages with each timeline instead of pinning a nested scroll region', () => {
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');
    const recent = readFileSync(resolve(desktopRoot, 'src/renderer/RecentMessages.svelte'), 'utf8');
    const styles = readFileSync(resolve(desktopRoot, 'src/renderer/style.css'), 'utf8');

    expect(app.indexOf('class="conversation"')).toBeLessThan(app.indexOf('<MessageTimeline runs={chatRuns}'));
    expect(app).not.toContain('global-attention');
    expect(recent).not.toContain('message-attention');
    expect(recent).toContain('<div class="scope-preview-history">');
    expect(recent.indexOf('<div class="scope-preview-history">'))
      .toBeLessThan(recent.indexOf('<MessageTimeline'));
    expect(recent).toContain('<div id="scoped-messages">');
    expect(recent).not.toContain('class:scope-preview-history={expanded}');
    expect(styles).not.toMatch(/\.global-attention|\.message-attention/);
  });

  it('keeps global pagination, unread, and focus separate from the complete scoped cache', () => {
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');
    expect(app).toContain('<MessageTimeline runs={chatRuns} {agentMessages} attachRunIds');
    expect(timeline).toContain('{#each visibleRows as row, index (row.key)}');
    expect(app).toContain('mergeMessageRows(chatRuns, agentMessages)');
    expect(app).toContain('loadedScopeKey === scopedHistoryKey ? scopedHistory : []');
    expect(app).toContain('const isCurrent = () => !cancelled && generation === environmentGeneration');
    expect(app).toContain('return () => { cancelled = true; }');
    expect(app).toContain('scopedHistoryRevision += 1');
    expect(app).toContain('scopedHistory = scopedHistory.filter((summary) => summary.id !== entry.id)');
    expect(entry).toContain('use:observeResponse=');
    expect(entry).toContain('id={attachRunIds && run ? chatRunDomId(run) : undefined}');
    expect(app).toContain('onFocus={(run) => void focusChatRun(run)}');
  });

  it('exposes discovery and switching through typed renderer-to-main IPC', () => {
    const contracts = readFileSync(resolve(desktopRoot, 'src/shared/contracts.ts'), 'utf8');
    const preload = readFileSync(resolve(desktopRoot, 'src/preload/index.ts'), 'utf8');
    const main = readFileSync(resolve(desktopRoot, 'src/main/index.ts'), 'utf8');

    expect(contracts).toContain('discoverEnvironments(): Promise<DesktopEnvironmentState>');
    expect(contracts).toContain('switchEnvironment(mcpUrl: string): Promise<DesktopEnvironmentState>');
    expect(preload).toContain("discoverEnvironments: () => invoke('environment:discover')");
    expect(preload).toContain("switchEnvironment: (mcpUrl) => invoke('environment:switch', mcpUrl)");
    expect(main).toContain("ipcMain.handle('environment:discover'");
    expect(main).toContain("ipcMain.handle('environment:switch'");
    expect(main).toContain('environmentManager.switchTo(mcpUrl, () => chatAgent.reset())');
  });

  it('renders linked pink user commands and compact read/write tool rows', () => {
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');
    const tools = readFileSync(resolve(desktopRoot, 'src/renderer/ToolActivity.svelte'), 'utf8');
    const styles = readFileSync(resolve(desktopRoot, 'src/renderer/style.css'), 'utf8');

    expect(entry).toContain('targetForRef(run.scope)');
    expect(entry).toContain('class="user-scope"');
    expect(tools).toContain("tool.mode === 'write' ? 'edit' : 'book'");
    expect(tools).toContain('class="tool-entity"');
    expect(entry).toContain('<ToolActivity {run}');
    expect(styles).toMatch(/\.user-entry,\s*\.assistant-entry\s*{[^}]*display:\s*grid[^}]*grid-template-columns:\s*26px minmax\(0,\s*1fr\)/s);
    expect(styles).not.toMatch(/\.user-entry[^{]*{[^}]*background:/s);
    expect(entry).toContain('<div class="user-markdown">{@html renderMarkdown(run.userText)}</div>');
    expect(styles).toMatch(/\.message-avatar\s*{[^}]*width:\s*26px[^}]*height:\s*26px/s);
    expect(styles).toMatch(/\.message-avatar\s*{[^}]*font-size:\s*11px[^}]*font-weight:\s*900/s);
    expect(styles).not.toMatch(/\.message-entry \.tool-activity\s*{[^}]*margin-left:/s);
    expect(styles).toMatch(/\.user-scope > \.codicon\s*{[^}]*color:\s*var\(--desktop-accent-strong\)[^}]*text-decoration:\s*none/s);
    expect(styles).toMatch(/\.user-scope\s*{[^}]*align-items:\s*center[^}]*padding:\s*6px 10px 2px[^}]*line-height:\s*16px/s);
    expect(styles).toMatch(/\.tool-activity > summary\s*{[^}]*align-items:\s*center[^}]*line-height:\s*16px/s);
    for (const selector of ['.user-scope > span:last-child', '.tool-activity > summary > span:last-child']) {
      const declaration = styles.slice(styles.indexOf(`${selector} {`)).split('}')[0];
      expect(declaration).toContain('text-decoration: none');
    }
    expect(styles).toMatch(/\.tool-rows li[^}]*min-height:\s*27px/s);
  });

  it('renders assistant responses as safe formatted Markdown', () => {
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');
    const markdown = readFileSync(resolve(desktopRoot, 'src/renderer/markdown.ts'), 'utf8');
    const styles = readFileSync(resolve(desktopRoot, 'src/renderer/style.css'), 'utf8');

    expect(entry).toContain('{@html renderMarkdown(run.assistantText)}');
    expect(markdown).toContain("new MarkdownIt({ html: false, linkify: true, breaks: true })");
    expect(styles).toMatch(/\.assistant-markdown :is\(h1, h2, h3, h4, h5, h6\)[^}]*font-size:\s*13px/s);
  });

  it('loads full journal detail only on activation and renders lifecycle metadata and partial states', () => {
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');

    expect(app).toContain('async function openToolDetail(row: ChatToolRow)');
    expect(app).toContain('window.workingMemory.getChatJournal(row.journalId)');
    expect(app).toContain('role="dialog"');
    expect(app).toContain('aria-modal="true"');
    expect(app).toContain('detail.call.argumentParseError');
    expect(app).toContain('detail.result.durationMs');
    expect(app).toContain('detail.call.retryOfCallId');
    expect(app).toContain('detail.call.dedupedOfCallId');
    expect(app).toContain('detail.confirmation.resolved?.resolution');
    expect(app).toContain('No result was persisted. This run is partial or was interrupted.');
    expect(app).toContain("detail.result?.status === 'cancelled'");
  });
});