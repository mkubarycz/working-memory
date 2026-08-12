/**
 * Part A of the prompt-block-marker feature: the run-prompt producer wraps
 * document-sourced blocks (template instructions + input/workstream topic
 * bodies) in terse `// START BLOCK … // END BLOCK` markers, while leaving
 * non-document-sourced sections (Context, Task, the self-report directive)
 * unwrapped. These tests pin the exact marker format + which blocks get wrapped.
 */

import { describe, expect, test } from 'vitest';
import {
  buildRunPrompt,
  seedInstructions,
  wrapSourcedBlock,
} from '../src/nanites/extensionHostRunner';
import type { NaniteTemplate, Topic, Workstream } from '../src/controlPlaneClient';

function topic(partial: Partial<Topic>): Topic {
  return {
    id: 'topic-id',
    slug: 'my-topic',
    title: 'My Topic',
    body: 'topic body text',
    status: 'open',
    topicType: 'task',
    parents: [],
    workstreams: [],
    focusedWorkstreams: [],
    created_at: 0,
    updated_at: 0,
    resourceVersion: 7,
    ...partial,
  };
}

function template(partial: Partial<NaniteTemplate>): NaniteTemplate {
  return {
    id: 'tmpl-id',
    slug: 'my-template',
    title: 'My Template',
    triggerPhrase: 'go',
    instructions: 'do the thing carefully',
    executionSettings: {},
    toolAllowlist: [],
    toolDenylist: [],
    allowRunWithoutHuman: false,
    inputSchema: {},
    outputSchema: {},
    acceptanceCriteria: '',
    acceptanceThreshold: 60,
    enabled: true,
    created_at: 0,
    updated_at: 0,
    resourceVersion: 3,
    ...partial,
  };
}

const workstream: Workstream = {
  id: 'ws-id',
  slug: 'my-ws',
  title: 'My WS',
  status: 'progress',
} as unknown as Workstream;

const NOW = new Date('2026-08-11T00:00:00.000Z');

describe('wrapSourcedBlock', () => {
  test('wraps content with route#field?v<version> markers', () => {
    expect(
      wrapSourcedBlock('/document/tmpl-id.working-memory', 'instructions', 3, 'hi'),
    ).toBe('// START BLOCK /document/tmpl-id.working-memory#instructions?v3\nhi\n// END BLOCK');
  });

  test('null route ⇒ raw content, unwrapped', () => {
    expect(wrapSourcedBlock(null, 'body', 1, 'raw')).toBe('raw');
  });

  test('missing version defaults to 0', () => {
    expect(wrapSourcedBlock('/topic/x.working-memory', 'body', undefined, 'c')).toContain(
      '#body?v0\n',
    );
  });
});

describe('buildRunPrompt input topic', () => {
  test('wraps the topic body by slug with field=body + resourceVersion', () => {
    const prompt = buildRunPrompt({
      workstream,
      topic: topic({ slug: 'alpha', resourceVersion: 9, body: 'the body' }),
      request: 'run it',
      template: template({}),
      now: NOW,
    });
    expect(prompt).toContain(
      '# Input topic\nMy Topic (alpha)\n\n// START BLOCK /topic/alpha.working-memory#body?v9\nthe body\n// END BLOCK',
    );
    // Context + Task stay UNWRAPPED.
    expect(prompt).toContain('# Context\nCurrent time:');
    expect(prompt).toContain('# Task\nrun it');
    expect(prompt).not.toMatch(/START BLOCK[^\n]*#\w+\?v\d+\n# Context/);
    // The workstream section is no longer emitted.
    expect(prompt).not.toContain('# Workstream');
    // Exactly one block: the topic body.
    expect(prompt.match(/START BLOCK/g)).toHaveLength(1);
  });

  test('a topic with no slug falls back to the document route', () => {
    const prompt = buildRunPrompt({
      workstream,
      topic: topic({ slug: null, id: 'abc-123', body: 'b' }),
      request: 'x',
      template: template({}),
      now: NOW,
    });
    expect(prompt).toContain('// START BLOCK /document/abc-123.working-memory#body?v7\nb\n// END BLOCK');
  });

  test('a topic with no slug and no id still produces valid (unwrapped) output', () => {
    const prompt = buildRunPrompt({
      workstream,
      topic: topic({ slug: null, id: '', body: 'body-here' }),
      request: 'x',
      template: template({}),
      now: NOW,
    });
    // The topic itself has no stable route ⇒ its body stays unwrapped, so no
    // blocks are present at all.
    expect(prompt).not.toContain('#body?v7');
    expect(prompt).toContain('# Input topic\nMy Topic (—)\n\nbody-here');
  });

  test('an empty topic body emits just the header (no empty block)', () => {
    const prompt = buildRunPrompt({
      workstream,
      topic: topic({ body: '' }),
      request: 'x',
      template: template({}),
      now: NOW,
    });
    // No topic block (empty body) and no other blocks are emitted.
    expect(prompt).not.toContain('/topic/');
    expect(prompt).toContain('# Input topic\nMy Topic (my-topic)');
  });
});

describe('buildRunPrompt workstream-wide (no input topic)', () => {
  test('emits a terse tool pointer, no inline topic content, no blocks', () => {
    const prompt = buildRunPrompt({
      workstream,
      topic: undefined,
      request: 'x',
      template: template({ toolAllowlist: [] }),
      now: NOW,
    });
    // The terse pointer line is present.
    expect(prompt).toContain(
      '# Input topics\nThis Nanite runs workstream-wide (no single input topic). Use the ' +
        'ws-workstream-read and ws-topic-read tools to discover and read the topics in this workstream.',
    );
    // Context + Task remain.
    expect(prompt).toContain('# Context\nCurrent time:');
    expect(prompt).toContain('# Task\nx');
    // No workstream section, no per-topic sections, no sourced blocks.
    expect(prompt).not.toContain('# Workstream');
    expect(prompt).not.toContain('# Topics in this workstream');
    expect(prompt).not.toContain('START BLOCK');
  });

  test('the pointer is emitted regardless of topic-read tool grant', () => {
    const prompt = buildRunPrompt({
      workstream,
      topic: undefined,
      request: 'x',
      template: template({ toolAllowlist: ['ws-topic-read'] }),
      now: NOW,
    });
    expect(prompt).toContain('# Input topics\nThis Nanite runs workstream-wide');
    expect(prompt).not.toContain('# Topics in this workstream');
    expect(prompt).not.toContain('START BLOCK');
  });
});

describe('seedInstructions', () => {
  test('wraps template instructions and leaves the self-report directive unwrapped', () => {
    const seeded = seedInstructions(template({ id: 'tmpl-id', resourceVersion: 3 }));
    expect(seeded).toContain(
      '// START BLOCK /document/tmpl-id.working-memory#instructions?v3\ndo the thing carefully\n// END BLOCK',
    );
    // The directive is present but NOT inside a block.
    expect(seeded).toContain('If you lack a tool or capability');
    expect(seeded.match(/START BLOCK/g)).toHaveLength(1);
    // Directive text falls AFTER the END BLOCK (outside the wrapped region).
    const endIdx = seeded.indexOf('// END BLOCK');
    expect(seeded.indexOf('If you lack a tool')).toBeGreaterThan(endIdx);
  });

  test('a template with no id ⇒ instructions unwrapped, still valid', () => {
    const seeded = seedInstructions(template({ id: '' }));
    expect(seeded).not.toContain('START BLOCK');
    expect(seeded).toContain('do the thing carefully');
    expect(seeded).toContain('If you lack a tool or capability');
  });

  test('a null template ⇒ just the directive', () => {
    const seeded = seedInstructions(null);
    expect(seeded).not.toContain('START BLOCK');
    expect(seeded).toContain('If you lack a tool or capability');
  });
});
