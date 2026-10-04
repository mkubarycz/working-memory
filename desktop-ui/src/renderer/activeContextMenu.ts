import type { PanelAction } from '../../../src/panelData';
import type { DocumentVM } from '../../../webview-ui/src/lib/types';
import { toIpcPayload } from '../preload/ipcPayload';

export interface ActiveMoveTarget {
  slug: string;
  title: string;
}

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
    }
  | {
      kind: 'move';
      title: 'Move to...';
      icon: 'arrow-swap';
      enabled: boolean;
      topic: string;
      targets: ActiveMoveTarget[];
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
  topic?: {
    topic: string;
    focused: boolean;
    sourceWorkstream: string;
    moveTargets: ActiveMoveTarget[];
  },
): ActiveContextMenuItem[] {
  const items: ActiveContextMenuItem[] = [];
  if (topic) {
    items.push({
      kind: 'focus',
      title: topic.focused ? 'Remove from Focus' : 'Add to Focus',
      icon: topic.focused ? 'pinned' : 'pin',
      enabled: Boolean(topic.topic),
      topic: topic.topic,
    });
    const targets = topic.moveTargets.filter((target) => target.slug !== topic.sourceWorkstream);
    items.push({
      kind: 'move',
      title: 'Move to...',
      icon: 'arrow-swap',
      enabled: Boolean(topic.topic) && targets.length > 0,
      topic: topic.topic,
      targets,
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