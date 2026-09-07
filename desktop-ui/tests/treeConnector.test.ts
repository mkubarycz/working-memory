import { describe, expect, it } from 'vitest';
import { treeConnectorPath } from '../src/renderer/treeConnector';

describe('treeConnectorPath', () => {
  it('follows consecutive indents in one straight path', () => {
    expect(treeConnectorPath([
      { x: 10, y: 15 },
      { x: 29, y: 47 },
      { x: 48, y: 79 },
    ])).toBe('M 10 15 L 29 47 L 48 79');
  });

  it('connects the deepest visible descendant to the next shallower sibling', () => {
    expect(treeConnectorPath([
      { x: 10, y: 15 },
      { x: 29, y: 47 },
      { x: 48, y: 79 },
      { x: 48, y: 111 },
      { x: 29, y: 143 },
    ])).toBe(
      'M 10 15 L 29 47 L 48 79 L 48 111 C 48 127 29 127 29 143',
    );
  });

  it('does not draw a direct sibling segment across an expanded child block', () => {
    const path = treeConnectorPath([
      { x: 29, y: 47 },
      { x: 48, y: 79 },
      { x: 48, y: 111 },
      { x: 29, y: 143 },
    ]);

    expect(path).not.toContain('L 29 143');
    expect(path).toContain('C 48 127 29 127 29 143');
  });

  it('returns an empty path when there are no visible dots', () => {
    expect(treeConnectorPath([])).toBe('');
  });
});