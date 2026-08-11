import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerKind,
  getKind,
  listKinds,
  clearKinds,
  validateSpec,
  defaultStatus,
  KindValidationError,
} from '../src/kinds/registry';
import { loadKinds } from '../src/kinds/loader';
import configModule from '../src/kinds/config';

describe('Config kind registry', () => {
  beforeEach(() => {
    clearKinds();
    registerKind(configModule.name, configModule.descriptor);
  });

  it('registers Config and lists it (case-sensitive)', () => {
    expect(listKinds()).toContain('Config');
    expect(getKind('Config')).toBeTruthy();
    expect(getKind('config')).toBeUndefined();
  });

  it('parses a valid spec (name + data + status)', () => {
    const parsed = validateSpec('Config', {
      name: 'Banking App Developer',
      data: { GH_TOKEN: 'ghp_abc', REGION: 'us-east-1' },
      status: 'active',
    });
    expect(parsed).toEqual({
      name: 'Banking App Developer',
      data: { GH_TOKEN: 'ghp_abc', REGION: 'us-east-1' },
      status: 'active',
    });
  });

  it('accepts an empty data map (data required but may be empty)', () => {
    expect(validateSpec('Config', { data: {} })).toEqual({ data: {} });
  });

  it('rejects a missing data map', () => {
    expect(() => validateSpec('Config', { name: 'x' })).toThrow(KindValidationError);
    expect(() => validateSpec('Config', { name: 'x' })).toThrow(/data/);
  });

  it('rejects a non-string data value', () => {
    expect(() =>
      // A number value violates the string-only value schema.
      validateSpec('Config', { data: { PORT: 8080 } as unknown as Record<string, string> }),
    ).toThrow(KindValidationError);
    expect(() =>
      validateSpec('Config', { data: { PORT: 8080 } as unknown as Record<string, string> }),
    ).toThrow(/data/);
  });

  it('rejects an unknown top-level field (spec is strict)', () => {
    expect(() =>
      validateSpec('Config', { data: {}, bogus: 1 } as unknown as Record<string, unknown>),
    ).toThrow(KindValidationError);
  });

  it('inherits Base envelope status ({})', () => {
    expect(defaultStatus('Config')).toEqual({});
  });
});

describe('Config kind loader', () => {
  beforeEach(() => {
    clearKinds();
  });

  it('auto-discovers Config from the kinds folder', async () => {
    const registered = await loadKinds();
    expect(registered).toContain('Config');
    expect(getKind('Config')).toBeTruthy();
  });
});
