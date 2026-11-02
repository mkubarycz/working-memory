import { describe, expect, it } from 'vitest';
import { formatDocumentTimestamp, formatRelativeDocumentTime } from '../src/renderer/documentDates';

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

  it.each([
    [0, 'now'],
    [30, 'in less than a minute'],
    [-30, 'less than a minute ago'],
    [8 * 60, 'in 8 minutes'],
    [-3 * 60, '3 minutes ago'],
    [60, 'in 1 minute'],
    [-60, '1 minute ago'],
    [3660, 'in 1 hour 1 minute'],
    [-3660, '1 hour 1 minute ago'],
    [25 * 3600, 'in 1 day 1 hour'],
    [-48 * 3600, '2 days ago'],
  ])('formats a %s-second offset as friendly relative time', (offset, expected) => {
    expect(formatRelativeDocumentTime(1_000_000 + offset, 1_000_000_000)).toBe(expected);
  });

  it.each([NaN, -1, 1.5, Infinity, 8_640_000_000_001])('rejects invalid relative timestamps: %s', (timestamp) => {
    expect(() => formatRelativeDocumentTime(timestamp)).toThrow(/valid Unix-seconds/);
  });
});
