import * as fs from 'fs';
import * as path from 'path';

/**
 * Minimal subset of `vscode.ExtensionContext` that this module needs.
 * Keeping it structural lets tests pass a plain object without pulling
 * in the `vscode` module.
 */
export interface DeployContext {
  extensionUri: { fsPath: string };
}

interface VscodeNotificationApi {
  window: {
    showWarningMessage: (message: string) => unknown;
    showInformationMessage: (message: string) => unknown;
  };
}

function loadVscode(): VscodeNotificationApi | null {
  try {
    // Lazy require so this module is importable in plain Node test envs.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('vscode') as VscodeNotificationApi;
  } catch {
    return null;
  }
}

interface TemplateSpec {
  /** Filename under `media/prompts/` in the extension. */
  source: string;
  /** Destination path relative to the hub root. */
  dest: string;
  /** `overwrite` rotates the existing file to a `.N.backup` first. */
  mode: 'overwrite' | 'ifMissing';
}

const TEMPLATES: TemplateSpec[] = [
  {
    source: 'working-memory.agent.md',
    dest: '.github/agents/working-memory.agent.md',
    mode: 'overwrite',
  },
  {
    source: 'AGENTS.md',
    dest: 'AGENTS.md',
    mode: 'ifMissing',
  },
  {
    source: 'user.instructions.md',
    dest: '.github/prompts/user.instructions.md',
    mode: 'ifMissing',
  },
];

/**
 * Rotate `<dest>` to `<dest>.<N>.backup` where N is the next available
 * integer starting at 0. Returns the rotated path, or `null` if there
 * was nothing to rotate.
 */
function rotateBackup(dest: string): string | null {
  if (!fs.existsSync(dest)) {
    return null;
  }
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  let n = 0;
  // Find max existing N+1.
  try {
    const entries = fs.readdirSync(dir);
    const prefix = `${base}.`;
    const suffix = '.backup';
    let max = -1;
    for (const entry of entries) {
      if (!entry.startsWith(prefix) || !entry.endsWith(suffix)) {
        continue;
      }
      const middle = entry.slice(prefix.length, entry.length - suffix.length);
      if (!/^\d+$/.test(middle)) {
        continue;
      }
      const parsed = Number.parseInt(middle, 10);
      if (parsed > max) {
        max = parsed;
      }
    }
    n = max + 1;
  } catch {
    n = 0;
  }
  const rotated = path.join(dir, `${base}.${n}.backup`);
  fs.renameSync(dest, rotated);
  return rotated;
}

interface DeployOutcome {
  /** `true` if `working-memory.agent.md` was newly created (no prior file). */
  agentFreshlyCreated: boolean;
  errors: { source: string; error: Error }[];
}

/**
 * Pure-ish core: does the filesystem work and reports an outcome. Exposed
 * for direct testing without needing to mock vscode.
 */
export function deployTemplatesCore(
  extensionPath: string,
  hub: string,
): DeployOutcome {
  const outcome: DeployOutcome = {
    agentFreshlyCreated: false,
    errors: [],
  };

  for (const spec of TEMPLATES) {
    try {
      const sourcePath = path.join(extensionPath, 'media', 'prompts', spec.source);
      const destPath = path.join(hub, spec.dest);

      if (spec.mode === 'ifMissing' && fs.existsSync(destPath)) {
        continue;
      }

      // Read source up front so a missing template fails before we touch
      // the destination.
      const content = fs.readFileSync(sourcePath);

      fs.mkdirSync(path.dirname(destPath), { recursive: true });

      if (spec.mode === 'overwrite') {
        const rotated = rotateBackup(destPath);
        if (spec.source === 'working-memory.agent.md' && rotated === null) {
          outcome.agentFreshlyCreated = true;
        }
      }

      fs.writeFileSync(destPath, content);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      outcome.errors.push({ source: spec.source, error });
    }
  }

  return outcome;
}

/**
 * Deploy agent templates from the extension's bundled `media/prompts/`
 * into the hub workspace. Safe to call on every activation:
 *  - `working-memory.agent.md` is always overwritten (with rotation).
 *  - `AGENTS.md` and `user.instructions.md` are only written if missing.
 *
 * Errors are caught per-file: a missing source template won't block the
 * others, and nothing here blocks extension activation.
 */
export function deployTemplates(context: DeployContext, hub: string): void {
  const outcome = deployTemplatesCore(context.extensionUri.fsPath, hub);
  const vscode = loadVscode();

  for (const { source, error } of outcome.errors) {
    console.error(
      `[working-memory] deployTemplates: failed to deploy ${source}:`,
      error,
    );
    vscode?.window.showWarningMessage(
      `Working Memory: failed to deploy template ${source} — ${error.message}`,
    );
  }

  if (outcome.agentFreshlyCreated) {
    vscode?.window.showInformationMessage(
      `Working Memory: deployed agent templates to ${hub}`,
    );
  }
}
