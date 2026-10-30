import { describe, expect, it } from 'vitest';
import type { Topic, Workstream } from '../../shared/controlPlaneClient';
import { buildWorkstreamPanels } from '../../shared/panelData';
import { backlogMoveActions, topicBacklogDocument } from '../src/renderer/topicBacklog';
import { restoreLocalDocumentTab } from '../src/renderer/documentTabs';

function workstream(id: string, status: Workstream['status'], position = 0): Workstream {
  return {
    id, title: id, status, position, closure: null,
    opened_at: 1, updated_at: 1, closed_at: status === 'closed' ? 1 : null, resourceVersion: 1,
  };
}

function topic(id: string, workstreams: string[]): Topic {
  return {
    id, title: id, body: '', status: 'open', topicType: 'type', parents: [],
    workstreams, focusedWorkstreams: [], created_at: 1, updated_at: 1, resourceVersion: 1,
  };
}

describe('backlog document', () => {
  it('keeps ordered backlog workstreams separate from topics outside active workstreams', () => {
    const panel = buildWorkstreamPanels({
      available: true,
      workstreams: [
        workstream('later', 'backlog', 2),
        workstream('inbox', 'backlog', 1),
        workstream('active', 'progress'),
        workstream('queued', 'queue'),
        workstream('closed', 'closed'),
      ],
      topics: [
        topic('inbox-topic', ['inbox']),
        topic('active-topic', ['active']),
        topic('queued-topic', ['queued']),
        topic('unassigned', []),
        topic('closed-only', ['closed']),
        topic('missing-only', ['missing']),
        topic('mixed', ['inbox', 'closed']),
      ],
    }).active;
    const backlog = topicBacklogDocument(panel);
    expect(restoreLocalDocumentTab({ kind: 'topic-backlog', identifier: 'open-topic-backlog' }, panel, false))
      .toEqual(backlog);
    expect(backlog.workstreams.map(item => item.id)).toEqual(['inbox', 'later']);
    expect(backlog.topics.map(item => item.label)).toEqual(['closed-only', 'missing-only', 'unassigned']);
    expect(backlog.workstreams[0]).toMatchObject({
      openUri: 'working-memory:/workstream/inbox.working-memory',
      actions: expect.arrayContaining([expect.objectContaining({ title: 'Send to In Progress' })]),
    });
    expect(panel.items.filter(item => item.kind === 'workstream-section').map(item => item.section))
      .toEqual(['queue', 'progress', 'backlog']);
  });

  it('keeps the tab identity while reflecting workstreams moving into and out of backlog', () => {
    const inbox = workstream('inbox', 'backlog');
    const panel = (status: Workstream['status']) => buildWorkstreamPanels({
      available: true, workstreams: [{ ...inbox, status }], topics: [topic('member', ['inbox'])],
    }).active;
    const before = topicBacklogDocument(panel('backlog'));
    const active = topicBacklogDocument(panel('progress'));
    const closed = topicBacklogDocument(panel('closed'));
    expect(before.workstreams).toHaveLength(1);
    expect(active.workstreams).toHaveLength(0);
    expect(active.topics).toHaveLength(0);
    expect(closed.workstreams).toHaveLength(0);
    expect(closed.topics).toHaveLength(1);
    expect([active.id, closed.id]).toEqual([before.id, before.id]);
    expect(inbox.status).toBe('backlog');
  });

  it('offers only the existing Queue and In Progress actions, preserving their IDs and enabled state', () => {
    const backlog = topicBacklogDocument(buildWorkstreamPanels({
      available: true, workstreams: [workstream('inbox', 'backlog')], topics: [],
    }).active);
    const inbox = backlog.workstreams[0];
    const actions = backlogMoveActions(inbox);
    expect(actions.map(action => [action.title, action.args])).toEqual([
      ['Send to Queue', [{ id: 'inbox', section: 'queue' }]],
      ['Send to In Progress', [{ id: 'inbox', section: 'progress' }]],
    ]);
    expect(actions.every(action => inbox.actions.includes(action))).toBe(true);
    expect(actions.every(action => action.command === 'working-memory.setWorkstreamSection')).toBe(true);
    actions[0].enabled = false;
    actions[0].title = 'Translated queue action';
    expect(backlogMoveActions(inbox)[0]).toBe(actions[0]);
    expect(backlogMoveActions(inbox)[0].enabled).toBe(false);
    inbox.actions.push(
      { command: 'other-command', title: 'Send to Queue', args: [{ section: 'queue' }] },
      { command: 'working-memory.setWorkstreamSection', title: 'Invalid action', args: [null] },
    );
    expect(backlogMoveActions(inbox)).toEqual(actions);
  });

  it('preserves the complete nested topic tree, closed children, and focused state', () => {
    const parent = { ...topic('parent', ['inbox']), focusedWorkstreams: ['inbox'] };
    const child = { ...topic('child', ['inbox']), parents: ['parent'] };
    const closed = { ...topic('closed-child', ['inbox']), parents: ['child'], status: 'closed' as const };
    const backlog = topicBacklogDocument(buildWorkstreamPanels({
      available: true, workstreams: [workstream('inbox', 'backlog')], topics: [parent, child, closed],
    }).active);
    expect(backlog.topics).toEqual([]);
    expect(backlog.workstreams[0].children[0].children).toMatchObject([{
      documentId: 'parent', focused: true, children: [{
        documentId: 'child', children: [{ documentId: 'closed-child', status: 'closed' }],
      }],
    }]);
  });

  it('handles empty and unavailable panels without losing either section', () => {
    expect(topicBacklogDocument(null)).toEqual({
      kind: 'topic-backlog', id: 'open-topic-backlog', title: 'Backlog', topics: [], workstreams: [],
    });
    expect(topicBacklogDocument(buildWorkstreamPanels({ available: false, workstreams: [] }).active))
      .toEqual(topicBacklogDocument(null));
    const backlog = topicBacklogDocument(buildWorkstreamPanels({
      available: true, workstreams: [workstream('empty-inbox', 'backlog')], topics: [],
    }).active);
    expect(backlog.workstreams).toHaveLength(1);
    expect(backlog.topics).toHaveLength(0);
  });
});
