import { describe, expect, it, vi } from 'vitest';
import { imageFilesFromTransfer } from '../webview-ui/src/lib/imageFiles';

function file(name: string, type: string): File {
  return { name, type, size: 10, lastModified: 1 } as File;
}

describe('imageFilesFromTransfer', () => {
  it('extracts a macOS clipboard image exposed only through data-transfer items', () => {
    const screenshot = file('image.png', 'image/png');
    const transfer = {
      files: [] as unknown as FileList,
      items: [{
        kind: 'file',
        type: 'image/png',
        getAsFile: vi.fn(() => screenshot),
      }] as unknown as DataTransferItemList,
    };

    expect(imageFilesFromTransfer(transfer)).toEqual([screenshot]);
  });

  it('prefers clipboard items when Electron also exposes the same image as a differently named file', () => {
    const screenshot = file('image.png', 'image/png');
    const duplicateRepresentation = {
      ...file('Screenshot 2026-10-04.png', 'image/png'),
      lastModified: 2,
    } as File;
    const transfer = {
      files: [duplicateRepresentation] as unknown as FileList,
      items: [{
        kind: 'file',
        type: 'image/png',
        getAsFile: () => screenshot,
      }] as unknown as DataTransferItemList,
    };

    expect(imageFilesFromTransfer(transfer)).toEqual([screenshot]);
  });

  it('ignores non-image clipboard files', () => {
    const transfer = {
      files: [file('notes.txt', 'text/plain')] as unknown as FileList,
      items: [] as unknown as DataTransferItemList,
    };

    expect(imageFilesFromTransfer(transfer)).toEqual([]);
  });
});
