import { test, expect } from 'vitest';
import {
  canonicalToLocalName,
  projectCatalog,
} from '../src/wmToolProjection';
import { buildToolEnvelopeSchema } from '../src/llamaClient';
import type { CanonicalToolDef } from '../src/controlPlaneClient';

test('canonicalToLocalName strips the ws-/wm- prefix and dashes → underscores', () => {
  expect(canonicalToLocalName('ws-topic-create')).toBe('topic_create');
  expect(canonicalToLocalName('ws-workstream-read')).toBe('workstream_read');
  expect(canonicalToLocalName('wm-document-delete')).toBe('document_delete');
  // No namespace prefix → just dash→underscore.
  expect(canonicalToLocalName('ping')).toBe('ping');
});

/** A representative slice of the control-plane's canonical `tools/list`. */
function sampleCanonical(): CanonicalToolDef[] {
  return [
    {
      name: 'ws-topic-create',
      description: 'Create a Topic.',
      inputSchema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Topic title.' },
          slug: { type: 'string', description: 'Unique slug.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    {
      name: 'wm-document-delete',
      description: 'Soft-delete a document by id.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, restore: { type: 'boolean' } },
        required: ['id'],
      },
    },
  ];
}

test('projectCatalog produces valid LlamaToolDefs carrying the canonical description + schema', () => {
  const { tools } = projectCatalog(sampleCanonical());
  expect(tools.map((t) => t.function.name)).toEqual(['topic_create', 'document_delete']);

  const topicCreate = tools[0];
  expect(topicCreate.type).toBe('function');
  expect(topicCreate.function.description).toBe('Create a Topic.');
  const params = topicCreate.function.parameters as {
    type?: string;
    $schema?: unknown;
    properties?: Record<string, unknown>;
    required?: string[];
  };
  // JSON-Schema shape preserved…
  expect(params.type).toBe('object');
  expect(Object.keys(params.properties ?? {})).toEqual(['title', 'slug']);
  expect(params.required).toEqual(['title']);
  // …but the dialect marker Ollama chokes on is dropped.
  expect(params.$schema).toBeUndefined();
});

test('projectCatalog exposes the generic document-delete tool (Michael: reach ALL of WM)', () => {
  const { tools, localToCanonical } = projectCatalog(sampleCanonical());
  expect(tools.some((t) => t.function.name === 'document_delete')).toBe(true);
  expect(localToCanonical.get('document_delete')).toBe('wm-document-delete');
});

test('the reverse map round-trips local → canonical for every projected tool', () => {
  const { tools, localToCanonical } = projectCatalog(sampleCanonical());
  for (const tool of tools) {
    const canonical = localToCanonical.get(tool.function.name);
    expect(canonical).toBeDefined();
    expect(canonicalToLocalName(canonical!)).toBe(tool.function.name);
  }
});

test('projectCatalog normalizes a missing inputSchema into an empty object schema', () => {
  const { tools } = projectCatalog([{ name: 'ws-topic-read' }]);
  const params = tools[0].function.parameters as { type?: string; properties?: unknown };
  expect(params.type).toBe('object');
  expect(params.properties).toEqual({});
  expect(tools[0].function.description).toBe('');
});

test('projectCatalog skips a name collision (first tool wins)', () => {
  const { tools, localToCanonical } = projectCatalog([
    { name: 'ws-topic-read', description: 'first' },
    { name: 'wm-topic-read', description: 'second (collides → skipped)' },
  ]);
  expect(tools).toHaveLength(1);
  expect(tools[0].function.description).toBe('first');
  expect(localToCanonical.get('topic_read')).toBe('ws-topic-read');
});

test('a denylist hides a canonical tool from the projection', () => {
  const { tools } = projectCatalog(sampleCanonical(), {
    denylist: new Set(['wm-document-delete']),
  });
  expect(tools.map((t) => t.function.name)).toEqual(['topic_create']);
});

test('an allowlist restricts the projection to exactly the listed tools', () => {
  const { tools } = projectCatalog(sampleCanonical(), {
    allowlist: new Set(['wm-document-delete']),
  });
  expect(tools.map((t) => t.function.name)).toEqual(['document_delete']);
});

test('the projected catalog still compiles a valid envelope grammar', () => {
  const { tools } = projectCatalog(sampleCanonical());
  const schema = buildToolEnvelopeSchema(tools) as {
    properties: { actions: { items: { anyOf: unknown[] } } };
  };
  const branches = schema.properties.actions.items.anyOf;
  // one branch per tool + the `respond` branch.
  expect(branches).toHaveLength(tools.length + 1);
});
