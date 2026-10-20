import { describe, expect, it } from 'vitest';
import { formatDocumentTimestamp } from '../src/renderer/documentDates';

describe('document timestamps', () => {
  it.each([
    [1792424423, '2026-10-19T15:40:23.000Z'],
    [1792518337, '2026-10-20T17:45:37.000Z'],
  ])('formats Unix seconds %s as the stored calendar date', (seconds, iso) => {
    expect(formatDocumentTimestamp(seconds)).toBe(new Date(iso).toLocaleString());
  });

  it('retains the placeholder for an absent timestamp', () => {
    expect(formatDocumentTimestamp(0)).toBe('—');
  });
});
