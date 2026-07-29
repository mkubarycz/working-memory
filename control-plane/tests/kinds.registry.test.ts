import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
  registerKind,
  getKind,
  listKinds,
  clearKinds,
  validateSpec,
  defaultStatus,
  KindValidationError,
} from '../src/kinds/registry';
import { Base } from '../src/kinds/base';
import topicModule from '../src/kinds/topic';

describe('kind registry', () => {
  beforeEach(() => {
    clearKinds();
    registerKind(topicModule.name, topicModule.descriptor);
  });

  it('registers Topic and lists it', () => {
    expect(listKinds()).toContain('Topic');
    expect(getKind('Topic')).toBeTruthy();
    // Names are case-sensitive: lowercase stays unregistered (freeform).
    expect(getKind('topic')).toBeUndefined();
  });

  it('composes the Topic spec on top of Base (extends composition)', () => {
    // Base contributes an (empty) object; Topic adds its own fields. The
    // composed schema accepts a full Topic spec.
    const parsed = validateSpec('Topic', {
      title: 'Hello',
      body: 'World',
      topicType: 'note',
      status: 'closed',
      workstreams: ['ws-one'],
    });
    expect(parsed).toEqual({
      title: 'Hello',
      body: 'World',
      topicType: 'note',
      status: 'closed',
      parents: [],
      workstreams: ['ws-one'],
      focusedWorkstreams: [],
    });
  });

  it('applies defaults (body "", topicType "topic", status "open")', () => {
    const parsed = validateSpec('Topic', { title: 'Only a title', workstreams: ['ws-one'] });
    expect(parsed).toEqual({
      title: 'Only a title',
      body: '',
      topicType: 'topic',
      status: 'open',
      parents: [],
      workstreams: ['ws-one'],
      focusedWorkstreams: [],
    });
  });

  it('rejects a missing title', () => {
    expect(() => validateSpec('Topic', {})).toThrow(KindValidationError);
    expect(() => validateSpec('Topic', {})).toThrow(/title/);
  });

  it('rejects an empty title', () => {
    expect(() => validateSpec('Topic', { title: '' })).toThrow(KindValidationError);
  });

  it('rejects a title longer than 120 chars', () => {
    const longTitle = 'x'.repeat(121);
    let caught: unknown;
    try {
      validateSpec('Topic', { title: longTitle });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(KindValidationError);
    expect((caught as KindValidationError).issues.length).toBeGreaterThan(0);
  });

  it('defaultStatus("Topic") returns the Base default ({})', () => {
    expect(defaultStatus('Topic')).toEqual({});
  });

  it('a kind that omits status inherits Base status', () => {
    // Topic omits an envelope status schema → inherits Base's empty default.
    expect(Base.status).toBeTruthy();
    expect(defaultStatus('Topic')).toEqual({});
  });

  it('throws for unknown kinds', () => {
    expect(() => validateSpec('Nope', {})).toThrow(/Unknown kind/);
    expect(() => defaultStatus('Nope')).toThrow(/Unknown kind/);
  });

  it('supports a kind with its own status schema (extend, not replace)', () => {
    registerKind('Job', {
      spec: z.object({ prompt: z.string() }),
      status: z.object({ phase: z.enum(['Pending', 'Running']).default('Pending') }).default({
        phase: 'Pending',
      }),
    });
    expect(validateSpec('Job', { prompt: 'do it' })).toEqual({ prompt: 'do it' });
    expect(defaultStatus('Job')).toEqual({ phase: 'Pending' });
  });
});
