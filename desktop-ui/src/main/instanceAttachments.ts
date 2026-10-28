import { InstanceAuthenticationError, type ControlPlaneClient } from '../../../shared/controlPlaneClient';
import type { DesktopEnvironment } from '../shared/contracts';
import { instanceAttachmentBaseUrl } from '../shared/instanceAttachments';

export async function serveInstanceAttachment(
  request: Request, environment: DesktopEnvironment | null, client: Pick<ControlPlaneClient, 'fetch'>,
): Promise<Response> {
  const url = new URL(request.url);
  if (!environment || request.method !== 'GET' || url.protocol !== 'working-memory-attachment:'
    || url.host !== new URL(instanceAttachmentBaseUrl(environment.port)).host || !/^\/attachments\/[0-9a-f-]{36}$/i.test(url.pathname)
    || url.search || url.hash || url.username || url.password) {
    return new Response('Attachment does not belong to the selected instance.', { status: 403 });
  }
  try {
    const response = await client.fetch(new URL(url.pathname, environment.mcpUrl));
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'no-store');
    return new Response(response.body, { status: response.status, headers });
  } catch (error) {
    console.error('[desktop] Unable to load authenticated attachment:', error instanceof Error ? error.message : 'Unknown error');
    return new Response(error instanceof InstanceAuthenticationError
      ? 'Sign in to this instance and retry the attachment.'
      : 'Unable to load attachment. Check the instance connection and retry.', {
      status: error instanceof InstanceAuthenticationError ? 401 : 503,
      headers: { 'cache-control': 'no-store' },
    });
  }
}
