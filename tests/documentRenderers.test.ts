import { describe, it, expect } from 'vitest';
import type { DocumentEnvelope } from '../src/controlPlaneClient';
import {
  renderDocumentByKind,
  registerDocumentRenderer,
} from '../src/documentRenderers';
import { renderWorkstreamDocument } from '../src/documentRenderers/workstream';
import { renderTopicDocument } from '../src/documentRenderers/topic';
import { renderTopicTypeDocument } from '../src/documentRenderers/topictype';
import { renderAlertDocument } from '../src/documentRenderers/alert';
import { renderJournalEntryDocument } from '../src/documentRenderers/journalentry';

function makeEnvelope(
  kind: string,
  spec: Record<string, unknown>,
  metadata: Partial<DocumentEnvelope['metadata']> = {},
): DocumentEnvelope {
  return {
    kind,
    metadata: {
      id: 'doc-1',
      slug: 'the-slug',
      labels: {},
      createdAt: 1000,
      updatedAt: 2000,
      deletedAt: null,
      resourceVersion: 5,
      ...metadata,
    },
    spec,
    status: {},
  };
}

describe('renderWorkstreamDocument', () => {
  it('renders heading, metadata and spec with no outbound refs', () => {
    const md = renderWorkstreamDocument(
      makeEnvelope('Workstream', {
        title: 'Control Plane',
        status: 'progress',
        closure: 'shipped',
      }),
    );
    expect(md).toContain('# Workstream: Control Plane');
    expect(md).toContain('`id`: `doc-1`');
    expect(md).toContain('`status`: progress');
    expect(md).toContain('`closure`: shipped');
  });

  it('renders _none_ for a missing closure', () => {
    const md = renderWorkstreamDocument(
      makeEnvelope('Workstream', { title: 'X', status: 'queue' }),
    );
    expect(md).toContain('`closure`: _none_');
  });
});

describe('renderTopicDocument', () => {
  it('renders heading, body and clickable workstream + parent deep links', () => {
    const md = renderTopicDocument(
      makeEnvelope('Topic', {
        title: 'Blackboard Tab',
        body: 'the body text',
        status: 'open',
        topicType: 'feature',
        workstreams: ['control-plane', 'blackboard'],
        parents: ['agentic-store'],
      }),
    );
    expect(md).toContain('# Topic: Blackboard Tab');
    expect(md).toContain('`topicType`: feature');
    expect(md).toContain('the body text');
    expect(md).toContain(
      '[control-plane](vscode://kubarycz.working-memory/open/workstream/control-plane)',
    );
    expect(md).toContain(
      '[blackboard](vscode://kubarycz.working-memory/open/workstream/blackboard)',
    );
    expect(md).toContain(
      '[agentic-store](vscode://kubarycz.working-memory/open/topic/agentic-store)',
    );
  });

  it('renders _none_ for missing / foreign-shaped ref fields', () => {
    const md = renderTopicDocument(
      makeEnvelope('Topic', {
        title: 'Bare',
        workstreams: 'not-an-array',
      }),
    );
    // Both the Workstreams and Parents sections fall back to _none_.
    expect(md.match(/_none_/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe('renderTopicTypeDocument', () => {
  it('renders heading, spec fields and body template with no refs', () => {
    const md = renderTopicTypeDocument(
      makeEnvelope(
        'TopicType',
        {
          label: 'Feature',
          icon: 'rocket',
          description: 'A shippable capability.',
          body_template: '## Problem\n## Proposal',
        },
        { slug: 'feature' },
      ),
    );
    expect(md).toContain('# TopicType: Feature');
    expect(md).toContain('`icon`: rocket');
    expect(md).toContain('`description`: A shippable capability.');
    expect(md).toContain('## Problem');
  });
});

describe('renderAlertDocument', () => {
  it('renders heading, description, action and topic deep links', () => {
    const md = renderAlertDocument(
      makeEnvelope('Alert', {
        title: 'Disk full',
        description: 'The disk is at 95%.',
        recommended_action: 'Free space.',
        status: 'alert',
        topics: ['infra'],
      }),
    );
    expect(md).toContain('# Alert: Disk full');
    expect(md).toContain('`status`: alert');
    expect(md).toContain('The disk is at 95%.');
    expect(md).toContain('Free space.');
    expect(md).toContain(
      '[infra](vscode://kubarycz.working-memory/open/topic/infra)',
    );
  });

  it('derives the heading from the first line of description when title is empty', () => {
    const md = renderAlertDocument(
      makeEnvelope('Alert', {
        title: '',
        description: 'First line\nsecond line',
        status: 'informational',
      }),
    );
    expect(md).toContain('# Alert: First line');
  });
});

describe('renderJournalEntryDocument', () => {
  it('renders heading, body and workstream / session / topic deep links', () => {
    const md = renderJournalEntryDocument(
      makeEnvelope(
        'JournalEntry',
        {
          body: 'decision: chose option B',
          workstream: 'control-plane',
          session: 'sess-42',
          topics: ['blackboard', 'renderers'],
          createdBy: 'executor',
        },
        { slug: null },
      ),
    );
    expect(md).toContain('# JournalEntry: decision: chose option B');
    expect(md).toContain('`createdBy`: executor');
    expect(md).toContain(
      '[control-plane](vscode://kubarycz.working-memory/open/workstream/control-plane)',
    );
    expect(md).toContain(
      '[sess-42](vscode://kubarycz.working-memory/open/session/sess-42)',
    );
    expect(md).toContain(
      '[blackboard](vscode://kubarycz.working-memory/open/topic/blackboard)',
    );
  });

  it('omits the session link when session is absent', () => {
    const md = renderJournalEntryDocument(
      makeEnvelope(
        'JournalEntry',
        { body: 'fact: something', workstream: 'ws', topics: [] },
        { slug: null },
      ),
    );
    const sessionSection = md.slice(md.indexOf('## Session'));
    expect(sessionSection).toContain('_none_');
    expect(sessionSection).not.toContain('/open/session/');
  });
});

describe('renderDocumentByKind (dispatcher)', () => {
  it('routes a known kind to its per-kind renderer', () => {
    const env = makeEnvelope('Topic', {
      title: 'Routed',
      workstreams: ['ws-a'],
    });
    const md = renderDocumentByKind(env);
    expect(md).toContain('# Topic: Routed');
    expect(md).toContain('## Workstreams');
    // The generic fallback would emit a JSON envelope block; the topic
    // renderer does not.
    expect(md).not.toContain('## Envelope');
  });

  it('falls back to the generic envelope renderer for an unknown kind', () => {
    const env = makeEnvelope('SomethingElse', { foo: 'bar' });
    const md = renderDocumentByKind(env);
    expect(md).toContain('## Envelope');
    expect(md).toContain('```json');
    expect(md).toContain('`foo`: bar');
  });

  it('lets a later registration override a kind', () => {
    registerDocumentRenderer('OverrideKind', () => 'CUSTOM');
    expect(renderDocumentByKind(makeEnvelope('OverrideKind', {}))).toBe(
      'CUSTOM',
    );
  });
});
