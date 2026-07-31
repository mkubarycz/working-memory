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
import { renderNaniteDocument } from '../src/documentRenderers/nanite';
import { extractTopicBody } from '../src/editableRegions';
import {
  extractTopicTypeBodyTemplate,
  extractTopicTypeDescription,
  extractTopicTypeLabel,
} from '../src/editableRegions';

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
      '`topicType`: [feature](vscode://kubarycz.working-memory/open/topic-type/feature)',
    );
    expect(md).toContain('the body text');
    // Workstreams degrade to slug labels when no resolved titles are injected.
    expect(md).toContain(
      '[control-plane](vscode://kubarycz.working-memory/open/workstream/control-plane)',
    );
    expect(md).toContain(
      '[blackboard](vscode://kubarycz.working-memory/open/workstream/blackboard)',
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
      '[Workstream A](vscode://kubarycz.working-memory/open/workstream/ws-a)',
    );
    // Ancestors + descendant are friendly clickable links, indented 2/level.
    expect(md).toContain(
      '- [Grandparent](vscode://kubarycz.working-memory/open/topic/grandparent)',
    );
    expect(md).toContain(
      '  - [Parent](vscode://kubarycz.working-memory/open/topic/parent)',
    );
    // The current node is bold, NOT a link.
    expect(md).toContain('    - **Family Node**');
    expect(md).toContain(
      '      - [Child](vscode://kubarycz.working-memory/open/topic/child)',
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
      '- [ghost-parent](vscode://kubarycz.working-memory/open/topic/ghost-parent)',
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

  // Drift guard for the WM 13.0 topic-save cutover: the body the control-plane
  // renderer emits (between the editable markers) MUST round-trip back through
  // the journal extractor unchanged, so a save persists exactly what was typed.
  it('body round-trips through extractTopicBody (save contract)', () => {
    const md = renderTopicDocument(
      makeEnvelope('Topic', { title: 'RT', body: 'line one\n\nline two' }),
    );
    expect(extractTopicBody(md)).toBe('line one\n\nline two');
  });

  it('empty body round-trips to an empty string (save contract)', () => {
    const md = renderTopicDocument(makeEnvelope('Topic', { title: 'RT' }));
    expect(extractTopicBody(md)).toBe('');
  });

  // bug: topic-page-extra-headers — the intermediate `## Body` / `## Metadata`
  // H2 headings should NOT render; the metadata list + body content stay, and
  // the editable markers must remain intact so save still round-trips.
  it('omits the ## Body and ## Metadata headings but keeps content + markers', () => {
    const md = renderTopicDocument(
      makeEnvelope('Topic', { title: 'No Headers', body: 'the body text' }),
    );
    expect(md).not.toContain('## Body');
    expect(md).not.toContain('## Metadata');
    // Metadata list rows still render.
    expect(md).toContain('`id`: `doc-1`');
    // Body content + editable markers still present, and still round-trip.
    expect(md).toContain('<!-- editable:description -->');
    expect(md).toContain('<!-- /editable:description -->');
    expect(md).toContain('the body text');
    expect(extractTopicBody(md)).toBe('the body text');
    // No leftover blank-line gap where the heading was: the metadata list
    // flows straight into a single blank line before the editable marker.
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

  // Drift guard for the WM 13.0 topic-type-save cutover: label / description /
  // body-template must round-trip back through the journal extractors so a save
  // via ws-topictype-update persists exactly what was typed.
  it('label / description / body-template round-trip through the extractors', () => {
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
    expect(extractTopicTypeLabel(md)).toBe('Feature');
    expect(extractTopicTypeDescription(md)).toBe('A shippable capability.');
    expect(extractTopicTypeBodyTemplate(md)).toBe('## Problem\n## Proposal');
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

describe('renderNaniteDocument', () => {
  it('renders Request + Response as their OWN collapsed sections', () => {
    const md = renderNaniteDocument(
      makeEnvelope('Nanite', {
        phase: 'Succeeded',
        templateId: 'due-action-alerts',
        workstream: 'peanut-planting-season',
        inputTopic: 'plant-select-seed-variety',
        prompt: 'You are a helper.\n\n---\n\n# Task\ndo the thing',
        output: 'here is the answer',
      }),
    );
    expect(md).toContain('# Nanite: due-action-alerts');
    expect(md).toContain('`phase`: Succeeded');
    // Each blob is in its own collapsed disclosure...
    expect(md).toContain('<summary>Request — full prompt sent to the model</summary>');
    expect(md).toContain('<summary>Response — model output</summary>');
    expect(md).toContain('You are a helper.');
    expect(md).toContain('here is the answer');
    // ...and rendered VERBATIM in a fence so prompt headings don't become page
    // headings, and NOT dumped inline via a raw envelope block.
    expect(md).toContain('~~~text');
    expect(md).not.toContain('## Envelope');
    expect(md).not.toContain('```json');
    // Request comes before Response.
    expect(md.indexOf('<summary>Request')).toBeLessThan(md.indexOf('<summary>Response'));
    // Deep links for the workstream + input topic.
    expect(md).toContain('open/workstream/peanut-planting-season');
    expect(md).toContain('open/topic/plant-select-seed-variety');
  });

  it('omits a section whose field is empty', () => {
    const md = renderNaniteDocument(
      makeEnvelope('Nanite', { phase: 'Pending', prompt: '', output: '' }),
    );
    expect(md).not.toContain('<summary>Request');
    expect(md).not.toContain('<summary>Response');
    expect(md).toContain('# Nanite: doc-1');
    expect(md).toContain('`phase`: Pending');
  });

  it('is wired into the dispatcher for the Nanite kind', () => {
    const md = renderDocumentByKind(
      makeEnvelope('Nanite', { phase: 'Running', prompt: 'req', output: '' }),
    );
    expect(md).toContain('<summary>Request — full prompt sent to the model</summary>');
  });

  it('explains a Pending nanite as awaiting the user by default', () => {
    const md = renderNaniteDocument(makeEnvelope('Nanite', { phase: 'Pending' }));
    expect(md).toContain('## Status');
    expect(md).toContain('Waiting for approval');
    expect(md).toContain('will not run on its own');
    expect(md).toContain('**Run**');
    // Clickable Approve & Run deep link.
    expect(md).toContain('vscode://kubarycz.working-memory/nanite/doc-1/run');
    expect(md).not.toContain('allows unattended runs');
  });

  it('notes unattended runs on a Pending nanite but still says it will not run on its own', () => {
    const md = renderNaniteDocument(makeEnvelope('Nanite', { phase: 'Pending' }), {
      allowRunWithoutHuman: true,
    });
    expect(md).toContain('Waiting for approval');
    expect(md).toContain('will not run on its own');
    expect(md).toContain('allows unattended runs');
  });

  it('gives a plain-language status for Queued', () => {
    const md = renderNaniteDocument(makeEnvelope('Nanite', { phase: 'Queued' }));
    expect(md).toContain('**Queued**');
    expect(md).toContain('start automatically');
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
