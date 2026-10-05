import { describe, expect, it, vi } from 'vitest';
import { loadPromptImages } from '../src/main/promptImages';

const image = {
  attachment: {
    id: 'attachment/id',
    filename: 'camera.jpg',
    mimeType: 'image/jpeg',
  },
};

describe('loadPromptImages', () => {
  it('loads canonical attachment bytes and builds a provider data URL', async () => {
    const fetcher = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

    await expect(loadPromptImages(
      [image],
      'http://127.0.0.1:7717',
      fetcher,
      () => ['SC1:UE'],
    )).resolves.toEqual([{
      id: 'attachment/id',
      filename: 'camera.jpg',
      mimeType: 'image/jpeg',
      dataUrl: 'data:image/jpeg;base64,AQID',
      qrPayloads: ['SC1:UE'],
    }]);
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:7717/attachments/attachment%2Fid',
    );
  });

  it('reports an attachment read failure without making a model request', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 404 }));

    await expect(loadPromptImages([image], 'http://127.0.0.1:7717', fetcher))
      .rejects.toThrow('Unable to read prompt image "camera.jpg" (404).');
  });

  it('rejects unsupported image types before fetching bytes', async () => {
    const fetcher = vi.fn();

    await expect(loadPromptImages([{
      attachment: { ...image.attachment, mimeType: 'image/svg+xml' },
    }], 'http://127.0.0.1:7717', fetcher)).rejects.toThrow(
      'Unsupported image type: image/svg+xml',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
