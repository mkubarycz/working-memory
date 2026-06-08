import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Find the hub workspace folder — the one containing both `AGENTS.md` and
 * a `memory/` directory. Returns `null` if not found among the open folders.
 */
export function findHubWorkspace(): string | null {
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const agents = path.join(root, 'AGENTS.md');
    const memory = path.join(root, 'memory');
    try {
      if (fs.statSync(agents).isFile() && fs.statSync(memory).isDirectory()) {
        return root;
      }
    } catch {
      // not this folder
    }
  }
  return null;
}

/**
 * Resolve the SQLite path: `<hub>/memory/journal.sqlite`. Returns null if no
 * hub workspace is open.
 */
export function resolveDbPath(): string | null {
  const hub = findHubWorkspace();
  if (!hub) {
    return null;
  }
  return path.join(hub, 'memory', 'journal.sqlite');
}
