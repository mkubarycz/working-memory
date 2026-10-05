import type { ChatPromptImage } from '../shared/contracts';
import type { ModelImageInput } from './modelTools';

const SUPPORTED_IMAGE_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export async function loadPromptImages(
  images: ChatPromptImage[],
  attachmentBaseUrl: string,
  fetcher: typeof fetch = fetch,
  inspectQr: (data: Uint8Array) => string[] = () => [],
): Promise<ModelImageInput[]> {
  return Promise.all(images.map(async ({ attachment }) => {
    if (!SUPPORTED_IMAGE_TYPES.has(attachment.mimeType)) {
      throw new Error(`Unsupported image type: ${attachment.mimeType || '(missing)'}`);
    }
    const response = await fetcher(
      `${attachmentBaseUrl}/attachments/${encodeURIComponent(attachment.id)}`,
    );
    if (!response.ok) {
      throw new Error(`Unable to read prompt image "${attachment.filename}" (${response.status}).`);
    }
    const data = await response.arrayBuffer();
    if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) {
      throw new Error('Prompt images must be between 1 byte and 10 MB.');
    }
    const qrPayloads = inspectQr(new Uint8Array(data));
    return {
      id: attachment.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      dataUrl: `data:${attachment.mimeType};base64,${Buffer.from(data).toString('base64')}`,
      ...(qrPayloads.length ? { qrPayloads } : {}),
    };
  }));
}
