import { describe, it, expect } from 'vitest';
import type { DocumentEnvelope } from '../../shared/controlPlaneClient';
import {
  renderDocumentByKind,
  registerDocumentRenderer,
} from '../src/main/documentRenderers';
import { renderWorkstreamDocument } from '../src/main/documentRenderers/workstream';
import { renderTopicDocument } from '../src/main/documentRenderers/topic';
import { renderTopicTypeDocument } from '../src/main/documentRenderers/topictype';
import { renderAlertDocument } from '../src/main/documentRenderers/alert';

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

  // bug: topic-page-extra-headers — the shared metadata helper no longer emits
  // a `## Metadata` heading, so no per-kind virtual doc shows it; the list stays.
  it('omits the ## Metadata heading but keeps the metadata list', () => {
    const md = renderWorkstreamDocument(
      makeEnvelope('Workstream', { title: 'X', status: 'queue' }),
    );
    expect(md).not.toContain('## Metadata');
    expect(md).toContain('`id`: `doc-1`');
  });
});

describe('renderTopicDocument', () => {
  it('renders heading, body, a `## Family` section and friendly workstream links', () => {
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
    expect(md).toContain(
      '`topicType`: [feature](working-memory://open/topic-type/feature)',
    );
    expect(md).toContain('the body text');
    // Workstreams degrade to slug labels when no resolved titles are injected.
    expect(md).toContain(
      '[control-plane](working-memory://open/workstream/control-plane)',
    );
    expect(md).toContain(
      '[blackboard](working-memory://open/workstream/blackboard)',
    );
    // The flat `## Parents` section is gone; a `## Family` tree replaces it.
    expect(md).not.toContain('## Parents');
    expect(md).toContain('## Family');
    // With no injected family the section degrades to the current node only.
    expect(md).toContain('**Blackboard Tab**');
  });

  it('renders friendly workstream links + an ancestor/current/descendant Family tree', () => {
    const md = renderTopicDocument(
      makeEnvelope('Topic', {
        title: 'Family Node',
        body: 'b',
        workstreams: ['ws-a'],
      }),
      [],
      {
        workstreams: [{ slug: 'ws-a', title: 'Workstream A' }],
        family: [
          {
            slug: 'grandparent',
            title: 'Grandparent',
            isCurrent: false,
            children: [
              {
                slug: 'parent',
                title: 'Parent',
                isCurrent: false,
                children: [
                  {
                    slug: 'the-slug',
                    title: 'Family Node',
                    isCurrent: true,
                    children: [
                      {
                        slug: 'child',
                        title: 'Child',
                        isCurrent: false,
                        children: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    );
    // Friendly workstream link (title label, not slug).
    expect(md).toContain(
      '[Workstream A](working-memory://open/workstream/ws-a)',
    );
    // Ancestors + descendant are friendly clickable links, indented 2/level.
    expect(md).toContain(
      '- [Grandparent](working-memory://open/topic/grandparent)',
    );
    expect(md).toContain(
      '  - [Parent](working-memory://open/topic/parent)',
    );
    // The current node is bold, NOT a link.
    expect(md).toContain('    - **Family Node**');
    expect(md).toContain(
      '      - [Child](working-memory://open/topic/child)',
    );
  });

  it('falls back to the slug label for a dangling family ref', () => {
    const md = renderTopicDocument(makeEnvelope('Topic', { title: 'X' }), [], {
      family: [
        {
          slug: 'ghost-parent',
          title: 'ghost-parent',
          isCurrent: false,
          children: [
            {
              slug: 'the-slug',
              title: 'X',
              isCurrent: true,
              children: [],
            },
          ],
        },
      ],
    });
    // Title unresolved → the slug itself is the label, so the link never breaks.
    expect(md).toContain(
      '- [ghost-parent](working-memory://open/topic/ghost-parent)',
    );
  });

  it('renders _none_ workstreams and a single-node Family for a bare topic', () => {
    const md = renderTopicDocument(
      makeEnvelope('Topic', {
        title: 'Bare',
        workstreams: 'not-an-array',
      }),
    );
    // Workstreams falls back to _none_; Family shows just this topic.
    expect(md).toContain('## Workstreams\n\n_none_');
    expect(md).toContain('## Family');
    expect(md).toContain('**Bare**');
    expect(md).not.toContain('## Parents');
  });

  it('omits the ## Body and ## Metadata headings but keeps their content', () => {
    const md = renderTopicDocument(
      makeEnvelope('Topic', { title: 'No Headers', body: 'the body text' }),
    );
    expect(md).not.toContain('## Body');
    expect(md).not.toContain('## Metadata');
    // Metadata list rows still render.
    expect(md).toContain('`id`: `doc-1`');
    expect(md).toContain('the body text');
    // The metadata list flows straight into a single blank line before the body.
    expect(md).not.toContain('\n\n\n');
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
    expect(md).toContain('A shippable capability.');
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
      '[infra](working-memory://open/topic/infra)',
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
