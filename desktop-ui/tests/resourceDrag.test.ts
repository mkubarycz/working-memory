import { describe, expect, it, vi } from 'vitest';
import {
  resourceDragLink,
  setResourceDragData,
  WORKING_MEMORY_REFERENCE_MIME,
} from '../src/renderer/resourceDrag';

describe('desktop resource drag links', () => {
  it('converts canonical resource URIs into Markdown deep links', () => {
    expect(resourceDragLink(
      'working-memory:/topic/drag-desktop-item-links.working-memory',
      'Drag desktop item links',
    )).toEqual({
      href: 'http://127.0.0.1:7718/open/topic/drag-desktop-item-links',
      markdown: '[Drag desktop item links](http://127.0.0.1:7718/open/topic/drag-desktop-item-links)',
    });
  });

  it('preserves encoded identifiers and escapes Markdown labels', () => {
    expect(resourceDragLink(
      'working-memory:/document/id%2Fwith%20spaces.working-memory',
      String.raw`Run [latest] \ now`,
    )?.markdown).toBe(
      String.raw`[Run \[latest\] \\ now](http://127.0.0.1:7718/open/document/id%2Fwith%20spaces)`,
    );
  });

  it('exports link fallbacks and a resolvable context attachment', () => {
    const setData = vi.fn();
    const dataTransfer = { effectAllowed: 'none', setData } as unknown as DataTransfer;

    expect(setResourceDragData(
      dataTransfer,
      'working-memory:/workstream/working-memory-0-15-1.working-memory',
      'Working Memory 0.15.1',
      {
        filename: 'Working-Memory-0.15.1.md',
        filePath: '/tmp/working-memory-chat-context/Working-Memory-0.15.1.md',
        fileUrl: 'file:///tmp/working-memory-chat-context/Working-Memory-0.15.1.md',
      },
    )).toBe(true);
    expect(dataTransfer.effectAllowed).toBe('copy');
    expect(setData).toHaveBeenCalledWith(
      'text/plain',
      '[Working Memory 0.15.1](http://127.0.0.1:7718/open/workstream/working-memory-0-15-1)',
    );
    expect(setData).toHaveBeenCalledWith(
      'text/markdown',
      '[Working Memory 0.15.1](http://127.0.0.1:7718/open/workstream/working-memory-0-15-1)',
    );
    expect(setData).toHaveBeenCalledWith(
      'text/uri-list',
      'file:///tmp/working-memory-chat-context/Working-Memory-0.15.1.md',
    );
    expect(setData).toHaveBeenCalledWith(
      'DownloadURL',
      'text/markdown:Working-Memory-0.15.1.md:file:///tmp/working-memory-chat-context/Working-Memory-0.15.1.md',
    );
    expect(setData).toHaveBeenCalledWith(
      WORKING_MEMORY_REFERENCE_MIME,
      JSON.stringify({
        version: 1,
        title: 'Working Memory 0.15.1',
        href: 'http://127.0.0.1:7718/open/workstream/working-memory-0-15-1',
        uri: 'file:///tmp/working-memory-chat-context/Working-Memory-0.15.1.md',
      }),
    );
  });

  it('keeps link fallbacks when context preparation has not completed', () => {
    const setData = vi.fn();
    const dataTransfer = { effectAllowed: 'none', setData } as unknown as DataTransfer;

    expect(setResourceDragData(
      dataTransfer,
      'working-memory:/topic/context.working-memory',
      'Context',
    )).toBe(true);

    expect(setData).not.toHaveBeenCalledWith('text/uri-list', expect.anything());
    expect(setData).not.toHaveBeenCalledWith('DownloadURL', expect.anything());
  });

  it('ignores unsupported resource URIs', () => {
    expect(resourceDragLink('https://example.com/topic/one', 'One')).toBeNull();
  });
});