import { describe, expect, it, vi } from 'vitest';
import { resourceDragLink, setResourceDragData } from '../src/renderer/resourceDrag';

describe('desktop resource drag links', () => {
  it('converts canonical resource URIs into Markdown deep links', () => {
    expect(resourceDragLink(
      'working-memory:/topic/drag-desktop-item-links.working-memory',
      'Drag desktop item links',
    )).toEqual({
      href: 'vscode://kubarycz.working-memory/open/topic/drag-desktop-item-links',
      markdown: '[Drag desktop item links](vscode://kubarycz.working-memory/open/topic/drag-desktop-item-links)',
    });
  });

  it('preserves encoded identifiers and escapes Markdown labels', () => {
    expect(resourceDragLink(
      'working-memory:/document/id%2Fwith%20spaces.working-memory',
      String.raw`Run [latest] \ now`,
    )?.markdown).toBe(
      String.raw`[Run \[latest\] \\ now](vscode://kubarycz.working-memory/open/document/id%2Fwith%20spaces)`,
    );
  });

  it('exports copyable plain-text and Markdown payloads without a URI attachment type', () => {
    const setData = vi.fn();
    const dataTransfer = { effectAllowed: 'none', setData } as unknown as DataTransfer;

    expect(setResourceDragData(
      dataTransfer,
      'working-memory:/workstream/working-memory-0-15-1.working-memory',
      'Working Memory 0.15.1',
    )).toBe(true);
    expect(dataTransfer.effectAllowed).toBe('copy');
    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      '[Working Memory 0.15.1](vscode://kubarycz.working-memory/open/workstream/working-memory-0-15-1)',
    );
    expect(setData).toHaveBeenCalledWith(
      'text/markdown',
      '[Working Memory 0.15.1](vscode://kubarycz.working-memory/open/workstream/working-memory-0-15-1)',
    );
    expect(setData).not.toHaveBeenCalledWith('text/uri-list', expect.anything());
  });

  it('ignores unsupported resource URIs', () => {
    expect(resourceDragLink('https://example.com/topic/one', 'One')).toBeNull();
  });
});