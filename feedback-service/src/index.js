import { app } from '@azure/functions';
import { createService, HttpError, publicConfiguration } from './service.js';
import { createStorage } from './storage.js';

const storage = createStorage(process.env.FEEDBACK_STORAGE_ACCOUNT);
let handler;
async function boundedText(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Request body required.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Request body too large.'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
app.http('feedback', {
  methods: ['GET', 'POST', 'PUT'], authLevel: 'anonymous', route: '{*path}',
  handler: async (request, context) => {
    const headers = { 'cache-control': 'no-store', 'content-type': 'application/json', 'x-content-type-options': 'nosniff' };
    try {
      if (new URL(request.url).protocol !== 'https:') throw new HttpError(400, 'HTTPS is required.');
      handler ??= createService(storage, publicConfiguration(await storage.publicKey(), process.env.FEEDBACK_PUBLIC_URL));
      const response = await handler({
        method: request.method, path: request.params.path ?? '',
        deviceId: request.headers.get('x-feedback-device'),
        token: request.headers.get('authorization')?.startsWith('Bearer ')
          ? request.headers.get('authorization').slice(7) : undefined,
        contentLength: Number(request.headers.get('content-length')),
        text: limit => boundedText(request, limit),
        json: async limit => {
          const text = await boundedText(request, limit);
          try { return JSON.parse(text); } catch { throw new HttpError(400, 'Invalid JSON.'); }
        },
      });
      return { status: response.status, headers, jsonBody: response.body };
    } catch (error) {
      if (!(error instanceof HttpError)) context.error('Feedback service operation failed. Check storage identity, configuration and availability.');
      return { status: error instanceof HttpError ? error.status : 503, headers,
        jsonBody: { error: error instanceof HttpError ? error.message : 'Feedback temporarily unavailable; retry the same request.' } };
    }
  },
});
