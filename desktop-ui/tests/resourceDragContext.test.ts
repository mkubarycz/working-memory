import { describe, expect, it } from 'vitest';
import { resourceDragFilename } from '../src/main/resourceDragContext';

describe('resource drag context filenames', () => {
  it('keeps a readable label while including stable resource identity', () => {
    expect(resourceDragFilename('topic', 'first-topic', 'Release notes')).toMatch(
      /^Release-notes-[a-f0-9]{10}\.md$/,
    );
    expect(resourceDragFilename('topic', 'first-topic', 'Release notes')).toBe(
      resourceDragFilename('topic', 'first-topic', 'Release notes'),
    );
  });

  it('does not collide when resources share a label', () => {
    expect(resourceDragFilename('topic', 'first-topic', 'Shared title')).not.toBe(
      resourceDragFilename('topic', 'second-topic', 'Shared title'),
    );
    expect(resourceDragFilename('topic', 'shared', 'Shared title')).not.toBe(
      resourceDragFilename('workstream', 'shared', 'Shared title'),
    );
  });
});
