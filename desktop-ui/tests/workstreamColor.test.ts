import { describe, expect, it } from 'vitest';
import { colorIndexForId, workstreamColorClass } from '../src/renderer/workstreamColor';

function extensionColorIndexForId(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 15;
}

describe('workstream colors', () => {
  it('matches the VS Code panel algorithm across representative ids', () => {
    const ids = [
      '',
      'workstream',
      'queue:desktop-active-rail',
      'backlog:release-planning',
      '01234567-89ab-cdef-0123-456789abcdef',
      'a'.repeat(256),
      '日本語-workstream',
    ];

    for (const id of ids) {
      expect(colorIndexForId(id)).toBe(extensionColorIndexForId(id));
    }
  });

  it.each([
    ['workstream', 9],
    ['queue:desktop-active-rail', 4],
    ['backlog:release-planning', 0],
  ])('keeps the color assignment for %s stable', (id, expectedIndex) => {
    expect(colorIndexForId(id)).toBe(expectedIndex);
    expect(workstreamColorClass(id)).toBe(`ws-card-color-${expectedIndex}`);
  });
});