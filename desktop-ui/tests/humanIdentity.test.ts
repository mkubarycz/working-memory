import { describe, expect, it } from 'vitest';
import { humanInitials } from '../src/renderer/humanIdentity';

describe('human initials', () => {
  it('uses the first and last name initials', () => {
    expect(humanInitials('Flesh Bag')).toBe('FB');
    expect(humanInitials('Ada Middle Lovelace')).toBe('AL');
  });

  it('handles single and empty names', () => {
    expect(humanInitials('Mike')).toBe('MI');
    expect(humanInitials('  ')).toBe('FB');
  });
});
