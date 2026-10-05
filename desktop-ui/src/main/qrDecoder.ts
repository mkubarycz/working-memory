import jsQR from 'jsqr';

interface BitmapImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toBitmap(): Buffer;
}

type Decoder = typeof jsQR;

export function decodeQrPayloads(image: BitmapImage, decoder: Decoder = jsQR): string[] {
  if (image.isEmpty()) return [];
  const { width, height } = image.getSize();
  if (width <= 0 || height <= 0) return [];
  const bitmap = image.toBitmap();
  if (bitmap.length !== width * height * 4) return [];
  const result = decoder(new Uint8ClampedArray(bitmap), width, height, {
    inversionAttempts: 'attemptBoth',
  });
  return result?.data ? [result.data] : [];
}
