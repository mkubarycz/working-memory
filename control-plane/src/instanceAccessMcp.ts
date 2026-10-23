import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { AccessError, type InstanceAccess } from './instanceAccess.js';

export async function serveInstanceAccessMcp(
  req: IncomingMessage, res: ServerResponse, access: InstanceAccess,
): Promise<void> {
  res.setHeader('cache-control', 'no-store');
  const server = new McpServer({ name: 'working-memory-identity', version: '1.0.0' });
  const result = (action: () => unknown) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(action()) }] }; }
    catch (error) {
      if (!(error instanceof AccessError)) throw error;
      return { isError: true, content: [{ type: 'text' as const, text: error.message }] };
    }
  };
  server.registerTool('wm-identity-request-access', {
    title: 'Request Working Memory access',
    description: 'Request a new data-access credential or refresh an existing one. A signed-in owner must approve in the desktop Settings > Access. This tool cannot approve itself and grants no access before approval. For refresh, send the previous credential in the Authorization header, even if expired.',
    inputSchema: {
      label: z.string().trim().min(1).max(100).regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u),
      access: z.enum(['read', 'write']).default('read'),
      refresh: z.boolean().default(false),
    },
  }, async input => result(() => access.request(input,
    req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : '',
    req.socket.remoteAddress ?? 'unknown')));
  server.registerTool('wm-identity-claim-access', {
    title: 'Check and claim approved access',
    description: 'Poll an access request using its private requestSecret. Once the owner approves, returns a private bearer token exactly once. Store it securely and use it on /mcp, /attachments and /changes. Never put the token in a URL or share it with other clients.',
    inputSchema: { requestId: z.string().uuid(), requestSecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/) },
  }, async ({ requestId, requestSecret }) => result(() => access.claim(requestId, requestSecret)));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } finally {
    await transport.close();
    await server.close();
  }
}
