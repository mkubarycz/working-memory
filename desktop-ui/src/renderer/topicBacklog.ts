import type { PanelAction, PanelData, PanelWorkstream } from '../../../shared/panelData';
import type { TopicBacklogVM } from './documents/types';

export function backlogMoveActions(workstream: PanelWorkstream): PanelAction[] {
  return workstream.actions.filter(action => {
    const target = action.args?.[0];
    return action.command === 'working-memory.setWorkstreamSection'
      && typeof target === 'object' && target !== null && 'section' in target
      && (target.section === 'queue' || target.section === 'progress');
  });
}

export function topicBacklogDocument(panel: PanelData | null): TopicBacklogVM {
  return {
    kind: 'topic-backlog',
    id: 'open-topic-backlog',
    title: 'Backlog',
    workstreams: panel?.items.flatMap(item =>
      item.kind === 'workstream-section' && item.section === 'backlog' ? item.workstreams : []) ?? [],
    topics: panel?.topicBacklog ?? [],
  };
}
