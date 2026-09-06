import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopRoot = resolve(import.meta.dirname, '..');

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
    expect(main).toContain('journalId: result.journalId');
  });

  it('hydrates global history on startup and paginates older pages without replacing live runs', () => {
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');

    expect(app).toContain('void loadHistory();');
    expect(app).toContain('window.workingMemory.getChatHistory({');
    expect(app).toContain('chatRuns = mergeHistoryRuns(chatRuns, historyPage.journals);');
    expect(app).toContain('historyCursor = historyPage.nextCursor;');
    expect(app).toContain("onclick={() => void loadHistory(true)}");
    expect(app).toContain('conversationElement.scrollTop = previousTop + conversationElement.scrollHeight - previousHeight;');
    expect(app).toContain('Loading history…');
    expect(app).toContain('No chat history.');
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
    const styles = readFileSync(resolve(desktopRoot, 'src/renderer/style.css'), 'utf8');

    expect(app).toContain('targetForRef(run.scope)');
    expect(app).toContain('class="user-scope"');
    expect(app).toContain("tool.mode === 'write' ? 'edit' : 'book'");
    expect(app).toContain('class="tool-entity"');
    expect(styles).toMatch(/\.user-entry\s*{[^}]*background:\s*var\(--desktop-accent\)/s);
    expect(styles).toMatch(/\.user-entry pre[^}]*ui-monospace/s);
    expect(styles).toMatch(/\.tool-rows li[^}]*min-height:\s*27px/s);
  });

  it('renders assistant responses as safe formatted Markdown', () => {
    const app = readFileSync(resolve(desktopRoot, 'src/renderer/App.svelte'), 'utf8');
    const markdown = readFileSync(resolve(desktopRoot, 'src/renderer/markdown.ts'), 'utf8');
    const styles = readFileSync(resolve(desktopRoot, 'src/renderer/style.css'), 'utf8');

    expect(app).toContain('{@html renderMarkdown(run.assistantText)}');
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