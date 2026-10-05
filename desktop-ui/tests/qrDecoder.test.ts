import { describe, expect, it, vi } from 'vitest';
import { decodeQrPayloads } from '../src/main/qrDecoder';

describe('decodeQrPayloads', () => {
  it('passes native bitmap pixels to the QR decoder', () => {
    const decoder = vi.fn(() => ({ data: 'SC1:UE' }));
    const bitmap = Buffer.alloc(2 * 3 * 4, 255);

    expect(decodeQrPayloads({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 3 }),
      toBitmap: () => bitmap,
    }, decoder as never)).toEqual(['SC1:UE']);
    expect(decoder).toHaveBeenCalledWith(
      expect.any(Uint8ClampedArray),
      2,
      3,
      { inversionAttempts: 'attemptBoth' },
    );
  });

  it('skips empty or malformed native images', () => {
    const decoder = vi.fn();

    expect(decodeQrPayloads({
      isEmpty: () => true,
      getSize: () => ({ width: 0, height: 0 }),
      toBitmap: () => Buffer.alloc(0),
    }, decoder as never)).toEqual([]);
    expect(decodeQrPayloads({
      isEmpty: () => false,
      getSize: () => ({ width: 2, height: 2 }),
      toBitmap: () => Buffer.alloc(3),
    }, decoder as never)).toEqual([]);
    expect(decoder).not.toHaveBeenCalled();
  });
});
