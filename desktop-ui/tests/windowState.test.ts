import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseWindowBounds,
  readWindowBounds,
  resolveWindowBounds,
  writeWindowBounds,
  writeWindowBoundsSync,
} from '../src/main/windowState';

const options = { defaultWidth: 1280, defaultHeight: 820, minWidth: 900, minHeight: 600 };
const displays = [
  { workArea: { x: 0, y: 25, width: 1440, height: 875 }, primary: true },
  { workArea: { x: -1920, y: 0, width: 1920, height: 1080 } },
];

describe('desktop window state', () => {
  it('accepts finite bounds and rejects malformed persisted values', () => {
    expect(parseWindowBounds({ x: -20, y: 30, width: 1000, height: 700 }))
      .toEqual({ x: -20, y: 30, width: 1000, height: 700 });
    expect(parseWindowBounds({ x: 0, y: 0, width: '1000', height: 700 })).toBeNull();
    expect(parseWindowBounds({ x: 0, y: 0, width: Number.NaN, height: 700 })).toBeNull();
  });

  it('preserves bounds on a current display and enforces minimum dimensions', () => {
    expect(resolveWindowBounds({ x: -1700, y: 80, width: 700, height: 400 }, displays, options))
      .toEqual({ x: -1700, y: 80, width: 900, height: 600 });
  });

  it('centers current defaults on the primary display when saved bounds are off-screen', () => {
    expect(resolveWindowBounds({ x: 5000, y: 4000, width: 1000, height: 700 }, displays, options))
      .toEqual({ x: 80, y: 53, width: 1280, height: 820 });
  });

  it('clamps oversized windows to the available work area', () => {
    expect(resolveWindowBounds({ x: 20, y: 30, width: 2000, height: 1400 }, displays, options))
      .toEqual({ x: 0, y: 25, width: 1440, height: 875 });
  });

  it('round-trips state atomically and ignores corrupt files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-window-state-'));
    const filePath = join(directory, 'window-state.json');
    const bounds = { x: 42, y: 51, width: 1100, height: 720 };
    await writeWindowBounds(filePath, bounds);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual(bounds);
    expect(await readWindowBounds(filePath)).toEqual(bounds);
    await writeFile(filePath, '{broken', 'utf8');
    expect(await readWindowBounds(filePath)).toBeNull();
  });

  it('supports a synchronous close-path save', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'working-memory-window-state-close-'));
    const filePath = join(directory, 'window-state.json');
    const bounds = { x: 12, y: 20, width: 1200, height: 760 };
    writeWindowBoundsSync(filePath, bounds);
    expect(await readWindowBounds(filePath)).toEqual(bounds);
  });
});