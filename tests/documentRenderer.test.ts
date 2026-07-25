import { describe, it, expect } from 'vitest';
import {
  renderDocumentEnvelopeDoc,
  renderDocumentNotFoundDoc,
  renderControlPlaneUnavailableDoc,
} from '../src/documentRenderer';
import type { DocumentEnvelope } from '../src/controlPlaneClient';

function makeEnvelope(
  overrides: Partial<DocumentEnvelope> = {},
): DocumentEnvelope {
  return {
    kind: 'topic',
    metadata: {
      id: 'doc-123',
      slug: 'my-topic',
      labels: { area: 'ui' },
      createdAt: 1000,
      updatedAt: 2000,
      deletedAt: null,
      resourceVersion: 3,
    },
    spec: { title: 'My Topic', body: 'hello' },
    status: { phase: 'open' },
    ...overrides,
  } as DocumentEnvelope;
}

describe('renderDocumentEnvelopeDoc', () => {
  it('renders kind, metadata, labels, spec, status and a JSON envelope block', () => {
    const md = renderDocumentEnvelopeDoc(makeEnvelope());
    expect(md).toContain('# topic: my-topic');
    expect(md).toContain('## Kind');
    expect(md).toContain('## Metadata');
    expect(md).toContain('`id`: `doc-123`');
    expect(md).toContain('`resourceVersion`: 3');
    expect(md).toContain('### Labels');
    expect(md).toContain('`area`: ui');
    expect(md).toContain('## Spec');
    expect(md).toContain('`title`: My Topic');
    expect(md).toContain('## Status');
    expect(md).toContain('`phase`: open');
    expect(md).toContain('## Envelope');
    expect(md).toContain('```json');
    // The JSON block must round-trip to the original envelope.
    const jsonBlock = md.slice(md.indexOf('```json') + '```json'.length);
    const json = jsonBlock.slice(0, jsonBlock.indexOf('```')).trim();
    expect(JSON.parse(json).metadata.id).toBe('doc-123');
  });

  it('falls back to the id in the title when slug is missing', () => {
    const md = renderDocumentEnvelopeDoc(
      makeEnvelope({
        metadata: {
          id: 'doc-999',
          slug: null,
          labels: {},
          createdAt: null,
          updatedAt: null,
          deletedAt: null,
          resourceVersion: 1,
        },
      }),
    );
    expect(md).toContain('# topic: doc-999');
    expect(md).toContain('_none_');
  });
});

describe('renderDocumentNotFoundDoc', () => {
  it('mentions the id and a not-found heading', () => {
    const md = renderDocumentNotFoundDoc('gone-42');
    expect(md).toContain('# Document not found');
    expect(md).toContain('gone-42');
  });
});

describe('renderControlPlaneUnavailableDoc', () => {
  it('mentions the id and an unavailable heading', () => {
    const md = renderControlPlaneUnavailableDoc('doc-77');
    expect(md).toContain('# Control plane not running');
    expect(md).toContain('doc-77');
  });
});
