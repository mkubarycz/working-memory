import { describe, expect, it } from 'vitest';
import {
  ACTIVE_SECTION_MIN_HEIGHTS,
  resizeActiveSections,
} from '../src/renderer/activeSectionLayout';

const initial = { queue: 140, progress: 300, backlog: 160 };

describe('Active rail section layout', () => {
  it('moves the In Progress boundary between Queue and In Progress', () => {
    expect(resizeActiveSections('progress', 30, initial)).toEqual({
      queue: 170,
      progress: 270,
      backlog: 160,
    });
  });

  it('moves the Backlog boundary between In Progress and Backlog', () => {
    expect(resizeActiveSections('backlog', -40, initial)).toEqual({
      queue: 140,
      progress: 260,
      backlog: 200,
    });
  });

  it('clamps both sides of each boundary to useful minimum heights', () => {
    expect(resizeActiveSections('progress', -1_000, initial)).toEqual({
      queue: ACTIVE_SECTION_MIN_HEIGHTS.queue,
      progress: 364,
      backlog: 160,
    });
    expect(resizeActiveSections('backlog', 1_000, initial)).toEqual({
      queue: 140,
      progress: 384,
      backlog: ACTIVE_SECTION_MIN_HEIGHTS.backlog,
    });
  });
});