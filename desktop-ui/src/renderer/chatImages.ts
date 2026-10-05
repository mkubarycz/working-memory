import type { AttachmentRef } from './documents/types';

export const CHAT_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const CHAT_IMAGE_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export function validateChatImage(file: File): string | null {
  if (!CHAT_IMAGE_TYPES.has(file.type)) {
    return `Unsupported image type: ${file.type || file.name || '(missing)'}`;
  }
  if (file.size === 0) return `${file.name || 'Image'} is empty.`;
  if (file.size > CHAT_IMAGE_MAX_BYTES) {
    return `${file.name || 'Image'} exceeds the 10 MB size limit.`;
  }
  return null;
}

export function attachmentMarkdown(attachments: AttachmentRef[]): string {
  return attachments
    .map((attachment) => (
      `![${attachment.filename.replace(/[\[\]]/g, '')}](wm-attachment:${attachment.id})`
    ))
    .join('\n\n');
}
