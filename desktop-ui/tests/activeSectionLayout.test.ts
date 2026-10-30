import { describe, expect, it } from 'vitest';
import {
  ACTIVE_SECTION_MIN_HEIGHTS,
  resizeActiveSections,
} from '../src/renderer/activeSectionLayout';

const initial = { queue: 140, progress: 300 };

describe('Active rail section layout', () => {
  it('moves the In Progress boundary between Queue and In Progress', () => {
    expect(resizeActiveSections('progress', 30, initial)).toEqual({
      queue: 170,
      progress: 270,
    });
  });

  it('clamps Queue and In Progress to useful minimum heights', () => {
    expect(resizeActiveSections('progress', -1_000, initial)).toEqual({
      queue: ACTIVE_SECTION_MIN_HEIGHTS.queue,
      progress: 364,
    });
    expect(resizeActiveSections('progress', 1_000, initial)).toEqual({
      queue: 320,
      progress: ACTIVE_SECTION_MIN_HEIGHTS.progress,
    });
  });

  it('preserves the available height without mutating the measured layout', () => {
    const next = resizeActiveSections('progress', 70, initial);
    expect(next.queue + next.progress).toBe(initial.queue + initial.progress);
    expect(initial).toEqual({ queue: 140, progress: 300 });
  });
});