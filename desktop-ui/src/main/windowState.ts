import { renameSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DisplayArea {
  workArea: WindowBounds;
  primary?: boolean;
}

export interface WindowBoundsOptions {
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
}

const MIN_VISIBLE_EDGE = 64;
let temporaryFileSequence = 0;

function temporaryPath(filePath: string): string {
  temporaryFileSequence += 1;
  return `${filePath}.${process.pid}.${temporaryFileSequence}.tmp`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function parseWindowBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<WindowBounds>;
  if (![candidate.x, candidate.y, candidate.width, candidate.height].every(isFiniteNumber)) return null;
  if (candidate.width! <= 0 || candidate.height! <= 0) return null;
  return {
    x: Math.round(candidate.x!),
    y: Math.round(candidate.y!),
    width: Math.round(candidate.width!),
    height: Math.round(candidate.height!),
  };
}

function visibleOnDisplay(bounds: WindowBounds, display: DisplayArea): boolean {
  const area = display.workArea;
  const overlapWidth = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const overlapHeight = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return overlapWidth >= MIN_VISIBLE_EDGE && overlapHeight >= MIN_VISIBLE_EDGE;
}

function fitWithinDisplay(bounds: WindowBounds, area: WindowBounds, options: WindowBoundsOptions): WindowBounds {
  const width = Math.min(Math.max(bounds.width, options.minWidth), area.width);
  const height = Math.min(Math.max(bounds.height, options.minHeight), area.height);
  return {
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  };
}

export function resolveWindowBounds(
  saved: WindowBounds | null,
  displays: DisplayArea[],
  options: WindowBoundsOptions,
): WindowBounds | null {
  if (displays.length === 0) return saved;
  if (saved) {
    const display = displays.find((candidate) => visibleOnDisplay(saved, candidate));
    if (display) return fitWithinDisplay(saved, display.workArea, options);
  }

  const area = (displays.find((display) => display.primary) ?? displays[0]).workArea;
  const width = Math.min(Math.max(options.defaultWidth, options.minWidth), area.width);
  const height = Math.min(Math.max(options.defaultHeight, options.minHeight), area.height);
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
  };
}

export async function readWindowBounds(filePath: string): Promise<WindowBounds | null> {
  try {
    return parseWindowBounds(JSON.parse(await readFile(filePath, 'utf8')));
  } catch {
    return null;
  }
}

export async function writeWindowBounds(filePath: string, bounds: WindowBounds): Promise<void> {
  const pendingPath = temporaryPath(filePath);
  await writeFile(pendingPath, `${JSON.stringify(bounds)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(pendingPath, filePath);
}

export function writeWindowBoundsSync(filePath: string, bounds: WindowBounds): void {
  const pendingPath = temporaryPath(filePath);
  writeFileSync(pendingPath, `${JSON.stringify(bounds)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(pendingPath, filePath);
}