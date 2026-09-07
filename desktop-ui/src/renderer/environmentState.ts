import type { DocumentVM, SaveState } from '../../../webview-ui/src/lib/types';
import type { PanelData } from '../../../src/panelData';
import type { PendingConfirmation } from '../shared/contracts';
import type { ChatRun, ChatToolRow, ToolDetail } from './chatHistory';

export type SelectedTool = { row: ChatToolRow; detail?: ToolDetail; loading: boolean; error: string };

export interface EnvironmentBoundRendererState {
  input: string;
  documents: DocumentVM[];
  saveState: SaveState;
  documentError: string;
  chatRuns: ChatRun[];
  historyLoading: boolean;
  historyError: string;
  historyCursor: string | undefined;
  selectedTool: SelectedTool | null;
  pendingRunKey: string | null;
  busy: boolean;
  pendingConfirmation: PendingConfirmation | null;
  activePanel: PanelData | null;
  activeLoading: boolean;
  activeError: string;
  hasUnseenMessages: boolean;
}

export function emptyEnvironmentBoundRendererState(): EnvironmentBoundRendererState {
  return {
    input: '',
    documents: [],
    saveState: 'idle',
    documentError: '',
    chatRuns: [],
    historyLoading: false,
    historyError: '',
    historyCursor: undefined,
    selectedTool: null,
    pendingRunKey: null,
    busy: false,
    pendingConfirmation: null,
    activePanel: null,
    activeLoading: false,
    activeError: '',
    hasUnseenMessages: false,
  };
}

export async function reloadEnvironmentBoundData(
  loadActive: () => Promise<void>,
  loadHistory: () => Promise<void>,
): Promise<void> {
  await Promise.all([loadActive(), loadHistory()]);
}