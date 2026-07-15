import * as vscode from 'vscode';
import { NanitesStore } from './store';
import { runNanite, type NaniteLmBridge } from './runner';
import {
  type CreateNaniteInput,
  type ListNanitesInput,
  type UpdateNaniteInput,
} from './types';

/** Deps the nanite tools need from the host (panel refresh + the LM bridge). */
export interface NaniteToolDeps {
  refresh: () => void;
  bridge: NaniteLmBridge;
}

function jsonResult(data: unknown): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(JSON.stringify(data, null, 2)),
  ]);
}

function errorResult(message: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([
    new vscode.LanguageModelTextPart(
      JSON.stringify({ ok: false, error: message }, null, 2),
    ),
  ]);
}

function safe<TInput>(
  handler: (input: TInput) => unknown,
): (
  options: vscode.LanguageModelToolInvocationOptions<TInput>,
) => Promise<vscode.LanguageModelToolResult> {
  return async (options) => {
    try {
      return jsonResult(handler(options.input));
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }
  };
}

interface GetNaniteInput {
  slug: string;
  include_deleted?: boolean;
}

interface UpdateNaniteToolInput extends UpdateNaniteInput {
  slug: string;
}

interface NaniteSlugInput {
  slug: string;
}

interface RunNaniteToolInput {
  slug: string;
  prompt?: string;
  max_iterations?: number;
}

/**
 * Register the nanite language-model tools. CRUD/read wiring lives here; the
 * data work is in {@link NanitesStore} and the run loop in `runner.ts`.
 * Returns the disposables so the caller can track them.
 */
export function registerNaniteTools(
  store: NanitesStore,
  deps: NaniteToolDeps,
): vscode.Disposable[] {
  return [
    vscode.lm.registerTool<CreateNaniteInput>('wm_create_nanite', {
      invoke: safe<CreateNaniteInput>((input) => {
        if (!input.slug || !input.slug.trim()) {
          throw new Error('slug is required');
        }
        if (!input.instructions || !input.instructions.trim()) {
          throw new Error('instructions are required');
        }
        const nanite = store.createNanite(input);
        deps.refresh();
        return { ok: true, nanite };
      }),
    }),
    vscode.lm.registerTool<ListNanitesInput>('wm_list_nanites', {
      invoke: safe<ListNanitesInput>((input) => {
        const nanites = store.listNanites({
          include_disabled: input?.include_disabled,
          include_deleted: input?.include_deleted,
        });
        return { ok: true, count: nanites.length, nanites };
      }),
    }),
    vscode.lm.registerTool<GetNaniteInput>('wm_get_nanite', {
      invoke: safe<GetNaniteInput>((input) => {
        if (!input.slug) {
          throw new Error('slug is required');
        }
        const nanite = store.getNaniteBySlug(
          input.slug,
          input.include_deleted ?? false,
        );
        if (!nanite) {
          throw new Error(`nanite not found: ${input.slug}`);
        }
        const recent_runs = store.listRuns(nanite.id, 5);
        return { ok: true, nanite, recent_runs };
      }),
    }),
    vscode.lm.registerTool<UpdateNaniteToolInput>('wm_update_nanite', {
      invoke: safe<UpdateNaniteToolInput>((input) => {
        if (!input.slug || !input.slug.trim()) {
          throw new Error('slug is required');
        }
        const { slug, ...patch } = input;
        const nanite = store.updateNanite(slug, patch);
        deps.refresh();
        return { ok: true, nanite };
      }),
    }),
    vscode.lm.registerTool<NaniteSlugInput>('wm_delete_nanite', {
      invoke: safe<NaniteSlugInput>((input) => {
        if (!input.slug || !input.slug.trim()) {
          throw new Error('slug is required');
        }
        const soft_deleted = store.deleteNanite(input.slug);
        deps.refresh();
        return { ok: true, soft_deleted };
      }),
    }),
    vscode.lm.registerTool<NaniteSlugInput>('wm_restore_nanite', {
      invoke: safe<NaniteSlugInput>((input) => {
        if (!input.slug || !input.slug.trim()) {
          throw new Error('slug is required');
        }
        const restored = store.restoreNanite(input.slug);
        deps.refresh();
        return { ok: true, restored };
      }),
    }),
    vscode.lm.registerTool<RunNaniteToolInput>('wm_run_nanite', {
      // Not `safe`: the run loop is async and needs the cancellation token.
      invoke: async (options, token) => {
        try {
          const input = options.input;
          if (!input.slug) {
            throw new Error('slug is required');
          }
          const result = await runNanite(store, deps.bridge, {
            slug: input.slug,
            prompt: input.prompt,
            maxIterations: input.max_iterations,
            token,
          });
          deps.refresh();
          return jsonResult(result);
        } catch (err) {
          return errorResult(
            err instanceof Error ? err.message : String(err),
          );
        }
      },
    }),
  ];
}
