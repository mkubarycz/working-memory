import { describe, expect, it, vi } from 'vitest';
import {
  emptyEnvironmentBoundRendererState,
  reloadEnvironmentBoundData,
} from '../src/renderer/environmentState';

describe('renderer environment reset', () => {
  it('clears documents, Active data, history paging, live runs, confirmation, and inspector state', () => {
    expect(emptyEnvironmentBoundRendererState()).toEqual({
      input: '', documents: [], saveState: 'idle', documentError: '', chatRuns: [],
      historyLoading: false, historyError: '', historyCursor: undefined,
      selectedTool: null, pendingRunKey: null, busy: false, pendingConfirmation: null,
      activePanel: null, activeLoading: false, activeError: '', hasUnseenMessages: false,
    });
  });

  it('contracts environment reload to both Active and chat history paths', async () => {
    const loadActive = vi.fn(async () => {});
    const loadHistory = vi.fn(async () => {});
    await reloadEnvironmentBoundData(loadActive, loadHistory);
    expect(loadActive).toHaveBeenCalledOnce();
    expect(loadHistory).toHaveBeenCalledOnce();
  });
});