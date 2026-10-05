import { describe, expect, it } from 'vitest';
import {
  attachmentMarkdown,
  CHAT_IMAGE_MAX_BYTES,
  validateChatImage,
} from '../src/renderer/chatImages';

describe('chat images', () => {
  it('accepts supported images within the attachment limit', () => {
    expect(validateChatImage(new File(['image'], 'capture.png', {
      type: 'image/png',
    }))).toBeNull();
  });

  it('rejects unsupported, empty, and oversized images', () => {
    expect(validateChatImage(new File(['text'], 'note.txt', {
      type: 'text/plain',
    }))).toMatch(/Unsupported image type/);
    expect(validateChatImage(new File([], 'empty.png', {
      type: 'image/png',
    }))).toMatch(/empty/);
    expect(validateChatImage(new File([
      new Uint8Array(CHAT_IMAGE_MAX_BYTES + 1),
    ], 'large.png', {
      type: 'image/png',
    }))).toMatch(/10 MB/);
  });

  it('creates portable Markdown attachment references', () => {
    expect(attachmentMarkdown([{
      id: 'attachment-id',
      filename: 'screen[1].png',
      mimeType: 'image/png',
    }])).toBe('![screen1.png](wm-attachment:attachment-id)');
  });
});
