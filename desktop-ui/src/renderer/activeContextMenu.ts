import type { PanelAction } from '../../../src/panelData';
import type { DocumentVM } from '../../../webview-ui/src/lib/types';
import { toIpcPayload } from '../preload/ipcPayload';

export type ActiveContextMenuItem =
  | {
      kind: 'focus';
      title: string;
      icon: 'pin' | 'pinned';
      enabled: boolean;
      topic: string;
    }
  | {
      kind: 'action';
      title: string;
      icon: string;
      enabled: boolean;
      action: PanelAction;
    };

export function topicSlugFromOpenUri(openUri: string): string {
  try {
    const segment = new URL(openUri).pathname.split('/').at(-1) ?? '';
    return decodeURIComponent(segment.replace(/\.working-memory$/, ''));
  } catch {
    return '';
  }
}

export function activeContextMenuItems(
  actions: PanelAction[] = [],
  focus?: { topic: string; focused: boolean },
): ActiveContextMenuItem[] {
  const items: ActiveContextMenuItem[] = [];
  if (focus) {
    items.push({
      kind: 'focus',
      title: focus.focused ? 'Remove from Focus' : 'Add to Focus',
      icon: focus.focused ? 'pinned' : 'pin',
      enabled: Boolean(focus.topic),
      topic: focus.topic,
    });
  }
  return items.concat(actions.map((action) => ({
    kind: 'action' as const,
    title: action.title,
    icon: action.icon || 'arrow-swap',
    enabled: action.enabled !== false,
    action,
  })));
}

export function invokeActiveAction(
  invokeAction: (workstream: string, command: string, args: unknown[]) => Promise<DocumentVM>,
  workstream: string,
  action: PanelAction,
): Promise<DocumentVM> {
  return invokeAction(workstream, action.command, toIpcPayload(action.args ?? []));
}