/**
 * Public entrypoint for the prototype capture chat-session feature. Kept as a
 * single small surface so the host (`extension.ts`) touches exactly one line.
 */

import * as vscode from 'vscode';
import type { JournalStore } from '../db';
import { registerCaptureChatSession } from './provider';

/**
 * Register the Working Memory "capture" chat-session type. Never throws into
 * activation — a failure here (e.g. proposed API missing) is logged and
 * swallowed so the rest of the extension is unaffected.
 */
export function registerWorkingMemoryChatSession(
  context: vscode.ExtensionContext,
  store: JournalStore,
): void {
  try {
    registerCaptureChatSession(context, store);
  } catch (err) {
    console.error(
      '[working-memory] failed to register capture chat-session:',
      err,
    );
  }
}
