import * as vscode from 'vscode';
import { AlertsStore } from './store';
import {
  type AlertStatus,
  type CreateAlertInput,
  type ListAlertsInput,
} from './types';

/** Deps the alerts tools need from the host (panel refresh). */
export interface AlertToolDeps {
  refresh: () => void;
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

// ---------------------------------------------------------------------------
// Tool input shapes
// ---------------------------------------------------------------------------

interface GetAlertInput {
  id: number;
}
interface UpdateAlertToolInput {
  id: number;
  description?: string;
  recommended_action?: string;
  status?: AlertStatus;
}
interface AlertTopicLinkToolInput {
  alert_id: number;
  topic_slug: string;
}

/**
 * Register the alerts language-model tools. Pure wiring — the data work lives
 * in {@link AlertsStore}. Returns the disposables so the caller can track them.
 */
export function registerAlertTools(
  store: AlertsStore,
  deps: AlertToolDeps,
): vscode.Disposable[] {
  return [
    vscode.lm.registerTool<CreateAlertInput>('wm_create_alert', {
      invoke: safe<CreateAlertInput>((input) => {
        const result = store.createAlert(input);
        deps.refresh();
        return { ok: true, ...result };
      }),
    }),
    vscode.lm.registerTool<GetAlertInput>('wm_get_alert', {
      invoke: safe<GetAlertInput>((input) => {
        if (typeof input.id !== 'number') {
          throw new Error('id is required');
        }
        const alert = store.getAlert(input.id);
        if (!alert) {
          throw new Error(`alert not found: ${input.id}`);
        }
        return { ok: true, alert };
      }),
    }),
    vscode.lm.registerTool<ListAlertsInput>('wm_list_alerts', {
      invoke: safe<ListAlertsInput>((input) => {
        const alerts = store.listAlerts({
          status: input?.status,
          topic_slug: input?.topic_slug,
        });
        return { ok: true, count: alerts.length, alerts };
      }),
    }),
    vscode.lm.registerTool<UpdateAlertToolInput>('wm_update_alert', {
      invoke: safe<UpdateAlertToolInput>((input) => {
        if (typeof input.id !== 'number') {
          throw new Error('id is required');
        }
        const alert = store.updateAlert(input.id, {
          description: input.description,
          recommended_action: input.recommended_action,
          status: input.status,
        });
        deps.refresh();
        return { ok: true, alert };
      }),
    }),
    vscode.lm.registerTool<AlertTopicLinkToolInput>('wm_link_alert_topic', {
      invoke: safe<AlertTopicLinkToolInput>((input) => {
        if (typeof input.alert_id !== 'number' || !input.topic_slug) {
          throw new Error('alert_id and topic_slug are required');
        }
        const link = store.linkAlertTopic(input.alert_id, input.topic_slug);
        deps.refresh();
        return { ok: true, link };
      }),
    }),
    vscode.lm.registerTool<AlertTopicLinkToolInput>('wm_unlink_alert_topic', {
      invoke: safe<AlertTopicLinkToolInput>((input) => {
        if (typeof input.alert_id !== 'number' || !input.topic_slug) {
          throw new Error('alert_id and topic_slug are required');
        }
        const unlink = store.unlinkAlertTopic(input.alert_id, input.topic_slug);
        deps.refresh();
        return { ok: true, unlink };
      }),
    }),
  ];
}
